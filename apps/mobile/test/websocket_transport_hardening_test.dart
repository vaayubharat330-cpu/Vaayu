import 'dart:async';
import 'package:flutter_test/flutter_test.dart';
import '../lib/core/websocket/websocket_client.dart';

class FakeSocket implements IWebSocketChannel {
  final StreamController<dynamic> controller = StreamController<dynamic>.broadcast();
  final List<String> sent = [];
  bool closed = false;

  @override
  Stream<dynamic> get stream => controller.stream;

  @override
  void send(String message) => sent.add(message);

  @override
  Future<void> close([int? code, String? reason]) async {
    closed = true;
    await controller.close();
  }
}

void main() {
  test('authenticated websocket reconnect foundation restores rooms', () async {
    final socket = FakeSocket();
    String? url;
    final client = WebSocketClient(
      serverUrl: 'wss://example.test/ws',
      tokenProvider: () async => 'test-token',
      channelFactory: (value) {
        url = value;
        return socket;
      },
    );

    client.joinRoom('trip:trip-1');
    expect(await client.connect(), isTrue);
    expect(url, contains('token=test-token'));
    expect(socket.sent, contains('{"action":"join","room":"trip:trip-1"}'));

    socket.controller.add('{"event":"pong"}');
    await Future<void>.delayed(Duration.zero);
    expect(client.status, WebSocketStatus.connected);

    await client.dispose();
    expect(socket.closed, isTrue);
  });

  test('malformed frames are ignored without terminating the connection', () async {
    final socket = FakeSocket();
    final client = WebSocketClient(
      serverUrl: 'wss://example.test/ws',
      tokenProvider: () async => 'token',
      channelFactory: (_) => socket,
    );
    final messages = <Map<String, dynamic>>[];
    final subscription = client.messageStream.listen(messages.add);

    expect(await client.connect(), isTrue);
    socket.controller.add('not-json');
    socket.controller.add('{"event":"status","data":{"ok":true}}');
    await Future<void>.delayed(Duration.zero);

    expect(messages.length, 1);
    expect(messages.single['event'], 'status');
    expect(client.status, WebSocketStatus.connected);

    await subscription.cancel();
    await client.dispose();
  });
}
