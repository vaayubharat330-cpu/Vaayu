import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'dart:typed_data';

import 'package:camera/camera.dart';
import 'package:flutter/material.dart';

import '../../../core/network/api_client.dart';
import '../../../core/theme/vaayu_theme.dart';
import '../../../core/theme/vaayu_tokens.dart';

/// Authenticated live visual telemetry.
///
/// The driver publishes compressed camera frames at a controlled cadence. The backend
/// keeps only the latest frame and authorizes every read against the trip. This avoids
/// unbounded video storage while still giving operations/authorized participants a
/// near-real-time visual feed.
class LiveCameraShareScreen extends StatefulWidget {
  final ApiClient apiClient;
  final String tripId;
  final bool viewerOnly;

  const LiveCameraShareScreen({
    super.key,
    required this.apiClient,
    required this.tripId,
    this.viewerOnly = false,
  });

  @override
  State<LiveCameraShareScreen> createState() => _LiveCameraShareScreenState();
}

class _LiveCameraShareScreenState extends State<LiveCameraShareScreen> {
  CameraController? _camera;
  Timer? _captureTimer;
  Timer? _viewerTimer;
  String? _sessionId;
  Uint8List? _latestFrame;
  bool _starting = true;
  bool _sharing = false;
  bool _busy = false;
  int _sequence = 0;
  DateTime? _lastFrameAt;
  String? _error;

  @override
  void initState() {
    super.initState();
    if (widget.viewerOnly) {
      _loadViewerSession();
    } else {
      _startSharing();
    }
  }

  @override
  void dispose() {
    _captureTimer?.cancel();
    _viewerTimer?.cancel();
    _camera?.dispose();
    _stopSession();
    super.dispose();
  }

  Future<void> _startSharing() async {
    try {
      final cameras = await availableCameras();
      if (cameras.isEmpty) throw StateError('No camera available.');
      final selected = cameras.firstWhere(
        (camera) => camera.lensDirection == CameraLensDirection.back,
        orElse: () => cameras.first,
      );
      final controller = CameraController(selected, ResolutionPreset.medium, enableAudio: false, imageFormatGroup: ImageFormatGroup.jpeg);
      await controller.initialize();
      final response = await widget.apiClient.post('/api/trip/camera/session/start', body: {'trip_id': widget.tripId});
      if (!response.isSuccess || response.data is! Map || response.data['sessionId'] == null) {
        throw StateError(_errorFrom(response.data));
      }
      if (!mounted) return;
      _camera = controller;
      _sessionId = response.data['sessionId'].toString();
      setState(() { _starting = false; _sharing = true; });
      _captureTimer = Timer.periodic(const Duration(milliseconds: 1400), (_) => _publishFrame());
      await _publishFrame();
    } catch (error) {
      if (!mounted) return;
      setState(() { _starting = false; _error = 'Live camera could not start: $error'; });
    }
  }

  Future<void> _loadViewerSession() async {
    // Viewer mode receives a session id through the route/query in the parent product flow.
    // Polling is intentionally bounded and cache-free; no frames are persisted client-side.
    setState(() { _starting = false; _error = 'Viewer mode requires an active camera session id from the operations projection.'; });
  }

  Future<void> _publishFrame() async {
    if (_busy || !_sharing || _sessionId == null || _camera == null || !_camera!.value.isInitialized) return;
    _busy = true;
    try {
      final photo = await _camera!.takePicture();
      final bytes = await File(photo.path).readAsBytes();
      if (bytes.length > 900 * 1024) return;
      final response = await widget.apiClient.post('/api/trip/camera/frame', body: {
        'session_id': _sessionId,
        'image_data': 'data:image/jpeg;base64,${base64Encode(bytes)}',
      });
      if (response.isSuccess && response.data is Map) {
        final data = Map<String, dynamic>.from(response.data as Map);
        if (mounted) setState(() { _sequence = int.tryParse('${data['sequence']}') ?? _sequence + 1; _lastFrameAt = DateTime.now(); });
      }
    } catch (error) {
      if (mounted) setState(() => _error = 'Camera uplink interrupted: $error');
    } finally {
      _busy = false;
    }
  }

  Future<void> _stopSession() async {
    final session = _sessionId;
    if (session == null) return;
    _sessionId = null;
    try { await widget.apiClient.post('/api/trip/camera/session/stop', body: {'session_id': session}); } catch (_) {}
  }

  String _errorFrom(dynamic data) {
    if (data is Map) {
      final error = data['error'];
      if (error is Map) return error['message']?.toString() ?? 'Request rejected.';
      return error?.toString() ?? 'Request rejected.';
    }
    return 'Request rejected.';
  }

  @override
  Widget build(BuildContext context) {
    final colors = VaayuTheme.colorsOf(context);
    return Scaffold(
      appBar: AppBar(title: const Text('Live Camera')),
      body: _starting
          ? const Center(child: CircularProgressIndicator())
          : _error != null
              ? Center(child: Padding(padding: const EdgeInsets.all(24), child: Text(_error!, textAlign: TextAlign.center)))
              : Padding(
                  padding: const EdgeInsets.all(VaayuSpacing.md),
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.stretch,
                    children: [
                      Expanded(
                        child: ClipRRect(
                          borderRadius: BorderRadius.circular(18),
                          child: _camera != null
                              ? CameraPreview(_camera!)
                              : (_latestFrame == null
                                  ? Container(color: colors.surface, alignment: Alignment.center, child: const Text('Waiting for the next live frame…'))
                                  : Image.memory(_latestFrame!, fit: BoxFit.cover)),
                        ),
                      ),
                      const SizedBox(height: VaayuSpacing.md),
                      VaayuCard(
                        backgroundColor: colors.surface,
                        child: Padding(
                          padding: const EdgeInsets.all(VaayuSpacing.md),
                          child: Row(
                            children: [
                              Icon(_sharing ? Icons.videocam : Icons.videocam_off, color: _sharing ? colors.primary : colors.textTertiary),
                              const SizedBox(width: VaayuSpacing.sm),
                              Expanded(child: Text(_sharing ? 'LIVE • frame $_sequence' : 'Camera offline', style: TextStyle(fontWeight: FontWeight.w800, color: colors.textPrimary))),
                              if (_lastFrameAt != null) Text('${DateTime.now().difference(_lastFrameAt!).inSeconds}s ago', style: TextStyle(fontSize: 11, color: colors.textSecondary)),
                            ],
                          ),
                        ),
                      ),
                      const SizedBox(height: VaayuSpacing.sm),
                      const Text('Camera sharing is authorized per trip and stores only the latest encrypted-at-rest server frame. Stop sharing when the operational need ends.', style: TextStyle(fontSize: 11)),
                    ],
                  ),
                ),
    );
  }
}
