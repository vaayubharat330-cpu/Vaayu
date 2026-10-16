import 'dart:async';
import 'dart:convert';
import 'dart:math';

import 'package:web_socket_channel/web_socket_channel.dart';

enum WebSocketStatus {
  disconnected,
  connecting,
  connected,
  reconnecting,
}

abstract class IWebSocketChannel {
  void send(String message);
  Stream<dynamic> get stream;
  Future<void> close([int? code, String? reason]);
}

class WebSocketChannelAdapter implements IWebSocketChannel {
  final WebSocketChannel _channel;

  WebSocketChannelAdapter(this._channel);

  @override
  void send(String message) => _channel.sink.add(message);

  @override
  Stream<dynamic> get stream => _channel.stream;

  @override
  Future<void> close([int? code, String? reason]) async {
    await _channel.sink.close(code, reason);
  }
}

/// Single authoritative mobile WebSocket transport.
///
/// Provides authenticated connection lifecycle, bounded exponential reconnect
/// with jitter, durable room intent, application heartbeat and heartbeat
/// watchdog, while leaving all business state authoritative on the server.
///
/// Server events carry a stable `eventId`. The bounded deduplication cache is
/// deliberately transport-local: it protects the UI/state layer from duplicate
/// delivery after reconnects or multi-node fan-out without pretending that the
/// WebSocket is a durable event store. Dedupe is scoped to the room as well as
/// the event ID because one logical outbox event may legitimately be delivered
/// to several rooms subscribed by the same client.
class WebSocketClient {
  final String serverUrl;
  final Future<String> Function() _tokenProvider;
  final IWebSocketChannel Function(String url) _channelFactory;
  final Random _random;

  WebSocketStatus _status = WebSocketStatus.disconnected;
  IWebSocketChannel? _socket;
  StreamSubscription<dynamic>? _socketSubscription;
  Timer? _reconnectTimer;
  Timer? _heartbeatTimer;

  final Set<String> _rooms = <String>{};
  final StreamController<Map<String, dynamic>> _messages =
      StreamController<Map<String, dynamic>>.broadcast();
  final StreamController<WebSocketStatus> _statusController =
      StreamController<WebSocketStatus>.broadcast();

  final Map<String, DateTime> _seenEventIds = <String, DateTime>{};
  static const int _maxSeenEventIds = 512;
  static const Duration _seenEventTtl = Duration(minutes: 10);

  int _reconnectAttempts = 0;
  int _connectionGeneration = 0;
  bool _manualDisconnect = false;
  DateTime? _lastPongAt;
  bool _heartbeatOutstanding = false;

  static const int _baseReconnectDelayMs = 1000;
  static const int _maxReconnectDelayMs = 30000;
  static const Duration _heartbeatInterval = Duration(seconds: 25);
  static const Duration _heartbeatTimeout = Duration(seconds: 15);

  WebSocketClient({
    required this.serverUrl,
    required dynamic tokenProvider,
    IWebSocketChannel Function(String url)? channelFactory,
    Random? random,
  })  : _tokenProvider = _normalizeTokenProvider(tokenProvider),
        _channelFactory = channelFactory ?? _defaultChannelFactory,
        _random = random ?? Random();

  static Future<String> Function() _normalizeTokenProvider(dynamic provider) {
    if (provider is Future<String> Function()) return provider;
    if (provider != null) return () async => await provider.getValidToken();
    return () async => '';
  }

  static IWebSocketChannel _defaultChannelFactory(String url) {
    return WebSocketChannelAdapter(WebSocketChannel.connect(Uri.parse(url)));
  }

  WebSocketStatus get status => _status;
  bool get isConnected => _status == WebSocketStatus.connected;
  Set<String> get subscribedRooms => Set.unmodifiable(_rooms);
  Stream<Map<String, dynamic>> get messageStream => _messages.stream;
  Stream<WebSocketStatus> get statusStream => _statusController.stream;

  Future<bool> connect() async {
    if (_status == WebSocketStatus.connected) return true;
    if (_status == WebSocketStatus.connecting) return false;

    _manualDisconnect = false;
    _reconnectTimer?.cancel();
    _reconnectTimer = null;
    _updateStatus(
      _reconnectAttempts == 0 ? WebSocketStatus.connecting : WebSocketStatus.reconnecting,
    );

    final generation = ++_connectionGeneration;
    try {
      final token = await _tokenProvider();
      final uri = Uri.parse(serverUrl);
      final query = Map<String, String>.from(uri.queryParameters);
      if (token.isNotEmpty) query['token'] = token;
      final authenticatedUri = uri.replace(queryParameters: query);
      final channel = _channelFactory(authenticatedUri.toString());
      _socket = channel;

      _socketSubscription = channel.stream.listen(
        (raw) {
          if (generation != _connectionGeneration) return;
          _handleIncoming(raw);
        },
        onError: (Object error, StackTrace stack) {
          if (generation == _connectionGeneration) _handleDisconnect();
        },
        onDone: () {
          if (generation == _connectionGeneration) _handleDisconnect();
        },
        cancelOnError: true,
      );

      _reconnectAttempts = 0;
      _lastPongAt = DateTime.now().toUtc();
      _heartbeatOutstanding = false;
      _updateStatus(WebSocketStatus.connected);
      _startHeartbeat();
      _resubscribeRooms();
      return true;
    } catch (_) {
      if (generation == _connectionGeneration) _handleDisconnect();
      return false;
    }
  }

  bool send(Map<String, dynamic> message) {
    if (!isConnected || _socket == null) return false;
    try {
      _socket!.send(jsonEncode(message));
      return true;
    } catch (_) {
      _handleDisconnect();
      return false;
    }
  }

  void joinRoom(String roomName) {
    final room = roomName.trim();
    if (room.isEmpty) return;
    final added = _rooms.add(room);
    if (added && isConnected) send({'action': 'join', 'room': room});
  }

  void leaveRoom(String roomName) {
    final removed = _rooms.remove(roomName);
    if (removed && isConnected) send({'action': 'leave', 'room': roomName});
  }

  Future<void> disconnect({bool clearSubscriptions = true}) async {
    _manualDisconnect = true;
    _connectionGeneration++;
    _reconnectTimer?.cancel();
    _reconnectTimer = null;
    _heartbeatTimer?.cancel();
    _heartbeatTimer = null;
    _heartbeatOutstanding = false;
    _lastPongAt = null;

    await _socketSubscription?.cancel();
    _socketSubscription = null;
    final socket = _socket;
    _socket = null;
    if (socket != null) {
      try {
        await socket.close(1000, 'Normal Client Closure');
      } catch (_) {}
    }

    if (clearSubscriptions) _rooms.clear();
    _reconnectAttempts = 0;
    _updateStatus(WebSocketStatus.disconnected);
  }

  void _handleIncoming(dynamic raw) {
    Map<String, dynamic>? decoded;
    try {
      if (raw is String) {
        final value = jsonDecode(raw);
        if (value is Map) decoded = Map<String, dynamic>.from(value);
      } else if (raw is List<int>) {
        final value = jsonDecode(utf8.decode(raw));
        if (value is Map) decoded = Map<String, dynamic>.from(value);
      } else if (raw is Map) {
        decoded = Map<String, dynamic>.from(raw);
      }
    } catch (_) {
      return;
    }

    if (decoded == null) return;
    if (decoded['event'] == 'pong') {
      _lastPongAt = DateTime.now().toUtc();
      _heartbeatOutstanding = false;
    }

    final eventId = decoded['eventId'];
    if (eventId is String && eventId.isNotEmpty && eventId != 'pong') {
      final room = decoded['room'];
      final dedupeKey = room is String && room.isNotEmpty
          ? '$room\u0000$eventId'
          : eventId;
      if (_isDuplicateEvent(dedupeKey)) return;
    }

    _messages.add(decoded);
  }

  bool _isDuplicateEvent(String dedupeKey) {
    final now = DateTime.now().toUtc();
    _pruneSeenEvents(now);
    final previous = _seenEventIds[dedupeKey];
    if (previous != null && now.difference(previous) <= _seenEventTtl) {
      return true;
    }

    _seenEventIds[dedupeKey] = now;
    while (_seenEventIds.length > _maxSeenEventIds) {
      _seenEventIds.remove(_seenEventIds.keys.first);
    }
    return false;
  }

  void _pruneSeenEvents(DateTime now) {
    _seenEventIds.removeWhere((_, seenAt) => now.difference(seenAt) > _seenEventTtl);
  }

  void _resubscribeRooms() {
    for (final room in List<String>.from(_rooms)) {
      send({'action': 'join', 'room': room});
    }
  }

  void _handleDisconnect() {
    if (_manualDisconnect) return;
    _heartbeatTimer?.cancel();
    _heartbeatTimer = null;
    _heartbeatOutstanding = false;
    _socketSubscription?.cancel();
    _socketSubscription = null;
    _socket = null;
    if (_status != WebSocketStatus.disconnected) {
      _updateStatus(WebSocketStatus.reconnecting);
      _scheduleReconnect();
    }
  }

  void _scheduleReconnect() {
    if (_manualDisconnect || _reconnectTimer != null) return;
    final exponential = min(
      _maxReconnectDelayMs,
      _baseReconnectDelayMs * pow(2, _reconnectAttempts).toInt(),
    );
    final jitter = max(0, (exponential * 0.25).round());
    final minDelay = max(0, exponential - jitter);
    final maxDelay = exponential + jitter;
    final delayMs = minDelay + _random.nextInt(max(1, maxDelay - minDelay + 1));
    _reconnectAttempts++;
    _reconnectTimer = Timer(Duration(milliseconds: delayMs), () {
      _reconnectTimer = null;
      connect();
    });
  }

  void _startHeartbeat() {
    _heartbeatTimer?.cancel();
    _heartbeatTimer = Timer.periodic(_heartbeatInterval, (_) {
      if (!isConnected) return;
      final now = DateTime.now().toUtc();
      if (_heartbeatOutstanding &&
          _lastPongAt != null &&
          now.difference(_lastPongAt!) > _heartbeatTimeout) {
        _forceTransportFailure();
        return;
      }
      if (send({'action': 'ping'})) _heartbeatOutstanding = true;
    });
  }

  void _forceTransportFailure() {
    final socket = _socket;
    _socket = null;
    try {
      socket?.close(1001, 'Heartbeat timeout');
    } catch (_) {}
    _handleDisconnect();
  }

  void _updateStatus(WebSocketStatus next) {
    if (_status == next) return;
    _status = next;
    if (!_statusController.isClosed) _statusController.add(next);
  }

  Future<void> dispose() async {
    await disconnect();
    _seenEventIds.clear();
    await _messages.close();
    await _statusController.close();
  }
}

typedef ResilientWebSocketClient = WebSocketClient;
