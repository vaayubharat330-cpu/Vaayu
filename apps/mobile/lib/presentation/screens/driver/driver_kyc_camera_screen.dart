import 'dart:convert';
import 'dart:io';

import 'package:camera/camera.dart';
import 'package:flutter/material.dart';
import 'package:image/image.dart' as img;

import '../../../core/network/api_client.dart';
import '../../../core/services/document_field_extractor.dart';
import '../../../core/theme/vaayu_theme.dart';
import '../../../core/theme/vaayu_tokens.dart';

class DriverKycCameraScreen extends StatefulWidget {
  final ApiClient apiClient;
  final String driverId;
  const DriverKycCameraScreen({super.key, required this.apiClient, required this.driverId});
  @override State<DriverKycCameraScreen> createState() => _DriverKycCameraScreenState();
}

class _DriverKycCameraScreenState extends State<DriverKycCameraScreen> {
  final DocumentFieldExtractor _extractor = DocumentFieldExtractor();
  CameraController? _camera;
  bool _initializing = true;
  bool _capturing = false;
  bool _extracting = false;
  String? _error;
  String _selectedDocument = 'DRIVING_LICENSE';
  XFile? _captured;
  DocumentExtractionResult? _extraction;
  Map<String, dynamic>? _kycSummary;
  String? _uploadIntent;

  static const _documentTypes = <String, String>{
    'DRIVING_LICENSE': 'Driving licence',
    'RC': 'Vehicle RC',
    'INSURANCE': 'Vehicle insurance',
    'AADHAAR': 'Aadhaar',
    'PAN': 'PAN card',
    'VEHICLE_PHOTO': 'Vehicle photo / number plate',
    'PROFILE_PHOTO': 'Profile photo',
  };

  @override
  void initState() { super.initState(); _initializeCamera(); _loadKyc(); }
  @override
  void dispose() { _camera?.dispose(); _extractor.dispose(); super.dispose(); }

  Future<void> _initializeCamera() async {
    try {
      final cameras = await availableCameras();
      if (cameras.isEmpty) throw StateError('No camera is available on this device.');
      final preferred = cameras.firstWhere((camera) => camera.lensDirection == CameraLensDirection.back, orElse: () => cameras.first);
      final controller = CameraController(preferred, ResolutionPreset.high, enableAudio: false, imageFormatGroup: ImageFormatGroup.jpeg);
      await controller.initialize();
      if (!mounted) { await controller.dispose(); return; }
      setState(() { _camera = controller; _initializing = false; });
    } catch (error) {
      if (mounted) setState(() { _initializing = false; _error = 'Camera could not be started: $error'; });
    }
  }

  Future<void> _loadKyc() async {
    final response = await widget.apiClient.get('/api/documents', queryParameters: {'driver_id': widget.driverId});
    if (!mounted || !response.isSuccess || response.data is! Map) return;
    final data = Map<String, dynamic>.from(response.data as Map);
    setState(() => _kycSummary = data['kyc_summary'] is Map ? Map<String, dynamic>.from(data['kyc_summary']) : null);
  }

  Future<void> _capture() async {
    final camera = _camera;
    if (camera == null || !camera.value.isInitialized || _capturing) return;
    setState(() { _capturing = true; _extraction = null; });
    try {
      final file = await camera.takePicture();
      if (!mounted) return;
      setState(() { _captured = file; _extracting = true; _uploadIntent = 'kyc-${widget.driverId}-$_selectedDocument-${DateTime.now().microsecondsSinceEpoch}'; });
      final result = await _extractor.extract(imagePath: file.path, documentType: _selectedDocument);
      if (!mounted) return;
      setState(() { _extraction = result; _extracting = false; });
    } catch (error) {
      if (mounted) { setState(() => _extracting = false); _showError('Image processing failed. Retake the image with the document clearly visible: $error'); }
    } finally { if (mounted) setState(() => _capturing = false); }
  }

  Future<String> _compressedDataUri(String path) async {
    final source = await File(path).readAsBytes();
    final decoded = img.decodeImage(source);
    if (decoded == null) throw StateError('Captured image could not be decoded.');
    final oriented = img.bakeOrientation(decoded);
    var width = oriented.width; var height = oriented.height;
    if (width > 1800) { height = (height * 1800 / width).round(); width = 1800; }
    final resized = width == oriented.width ? oriented : img.copyResize(oriented, width: width, height: height, interpolation: img.Interpolation.linear);
    var quality = 82; var bytes = img.encodeJpg(resized, quality: quality);
    while (bytes.length > 850 * 1024 && quality > 45) { quality -= 7; bytes = img.encodeJpg(resized, quality: quality); }
    if (bytes.length > 900 * 1024) throw StateError('Captured document is too large. Move closer and retake the image.');
    return 'data:image/jpeg;base64,${base64Encode(bytes)}';
  }

  Future<void> _upload() async {
    final captured = _captured; final intent = _uploadIntent; final extraction = _extraction;
    if (captured == null || intent == null || _capturing || _extracting) return;
    setState(() => _capturing = true);
    try {
      final payload = await _compressedDataUri(captured.path);
      final response = await widget.apiClient.post('/api/documents/upload', body: {
        'driver_id': widget.driverId,
        'doc_type': _selectedDocument,
        'document_type': _selectedDocument,
        'image_data': payload,
      }, idempotencyKey: intent);
      if (!mounted) return;
      if (!response.isSuccess) { _showError(_extractError(response.data)); return; }

      var extractionPersisted = true;
      final responseData = response.data is Map ? Map<String, dynamic>.from(response.data as Map) : <String, dynamic>{};
      final document = responseData['document'] is Map ? Map<String, dynamic>.from(responseData['document'] as Map) : <String, dynamic>{};
      final documentId = document['id']?.toString();
      if (documentId != null && documentId.isNotEmpty && extraction != null && extraction.fields.isNotEmpty) {
        final extractionResponse = await widget.apiClient.post('/api/documents/extraction', body: {
          'driver_id': widget.driverId,
          'document_id': documentId,
          'document_type': _selectedDocument,
          'fields': extraction.fields,
        }, idempotencyKey: '$intent-extraction');
        extractionPersisted = extractionResponse.isSuccess;
      }

      setState(() { _captured = null; _extraction = null; _uploadIntent = null; });
      await _loadKyc();
      if (extractionPersisted) {
        ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text('Image processed. Required fields were extracted and securely stored for verification.')));
      } else {
        ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text('Image uploaded, but structured field persistence needs a retry.')));
      }
    } catch (error) {
      if (mounted) _showError('Upload failed: $error');
    } finally { if (mounted) setState(() => _capturing = false); }
  }

  void _resetCapture() { setState(() { _captured = null; _extraction = null; _uploadIntent = null; _extracting = false; }); }
  String _extractError(dynamic data) { if (data is Map) { final error = data['error']; if (error is Map) return error['message']?.toString() ?? 'Request rejected.'; return error?.toString() ?? data['message']?.toString() ?? 'Request rejected.'; } return 'Request rejected.'; }
  void _showError(String message) => ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(message), backgroundColor: Colors.red.shade700));

  String _fieldLabel(String key) {
    const labels = <String, String>{
      'vehicleNumber': 'Vehicle number', 'ownerName': 'Registered owner', 'vehicleClass': 'Vehicle class', 'fuelType': 'Fuel type',
      'registrationDate': 'Registration date', 'insuranceValidUntil': 'Insurance valid until', 'puccValidUntil': 'PUCC valid until',
      'chassisLast5': 'Chassis (last 5)', 'engineLast5': 'Engine (last 5)', 'licenseNumber': 'Driving licence number',
      'name': 'Name', 'dateOfBirth': 'Date of birth', 'issueDate': 'Issue date', 'validUntil': 'Licence valid until',
      'transportValidUntil': 'Transport validity', 'licensingAuthority': 'Licensing authority', 'policyNumber': 'Policy number',
      'insurer': 'Insurer', 'policyStartDate': 'Policy start', 'policyEndDate': 'Policy end', 'panNumber': 'PAN', 'aadhaarLast4': 'Aadhaar last 4',
    };
    return labels[key] ?? key;
  }

  Widget _buildExtractionCard(VaayuColors colors) {
    final extraction = _extraction;
    if (_extracting) return Card(color: colors.surface, child: const Padding(padding: EdgeInsets.all(VaayuSpacing.md), child: Row(children: [SizedBox(width: 22, height: 22, child: CircularProgressIndicator(strokeWidth: 2)), SizedBox(width: 12), Expanded(child: Text('Reading the captured image and extracting only required fields…'))])));
    if (extraction == null) return const SizedBox.shrink();
    return Card(color: colors.surface, child: Padding(padding: const EdgeInsets.all(VaayuSpacing.md), child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
      Row(children: [Icon(Icons.document_scanner_outlined, color: colors.primary), const SizedBox(width: 8), Expanded(child: Text(extraction.hasUsefulFields ? 'Detected information' : 'No required fields detected', style: TextStyle(fontWeight: FontWeight.w800, color: colors.textPrimary)))]),
      const SizedBox(height: 10),
      if (extraction.fields.isEmpty) Text('Retake the image with better lighting, less glare and the full document/number plate inside the frame.', style: TextStyle(color: colors.textSecondary, fontSize: 13))
      else ...extraction.fields.entries.map((entry) => Padding(padding: const EdgeInsets.only(bottom: 8), child: Row(crossAxisAlignment: CrossAxisAlignment.start, children: [SizedBox(width: 145, child: Text(_fieldLabel(entry.key), style: TextStyle(color: colors.textSecondary, fontSize: 12))), Expanded(child: Text(entry.value, style: TextStyle(color: colors.textPrimary, fontWeight: FontWeight.w700)))]))),
      if (extraction.warnings.isNotEmpty) ...[const SizedBox(height: 4), ...extraction.warnings.map((warning) => Padding(padding: const EdgeInsets.only(top: 4), child: Text('• $warning', style: TextStyle(color: colors.textSecondary, fontSize: 12))))],
      if (extraction.documentType == 'AADHAAR') ...[const SizedBox(height: 8), Text('Privacy: only the minimum required Aadhaar fields are extracted; the full Aadhaar number is not sent as a field.', style: TextStyle(color: colors.textSecondary, fontSize: 11))],
    ])));
  }

  @override
  Widget build(BuildContext context) {
    final colors = VaayuTheme.colorsOf(context);
    return Scaffold(
      appBar: AppBar(title: const Text('Driver KYC & Identity')),
      body: _initializing ? const Center(child: CircularProgressIndicator()) : _error != null ? _ErrorState(message: _error!, onRetry: _initializeCamera) : SafeArea(child: ListView(padding: const EdgeInsets.all(VaayuSpacing.md), children: [
        Card(color: colors.surface, child: Padding(padding: const EdgeInsets.all(VaayuSpacing.md), child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
          Text('Verification document', style: TextStyle(fontSize: 16, fontWeight: FontWeight.w800, color: colors.textPrimary)),
          const SizedBox(height: 8),
          DropdownButtonFormField<String>(initialValue: _selectedDocument, items: _documentTypes.entries.map((entry) => DropdownMenuItem(value: entry.key, child: Text(entry.value))).toList(), onChanged: (value) { if (value != null) setState(() { _selectedDocument = value; _captured = null; _extraction = null; _uploadIntent = null; }); }, decoration: const InputDecoration(border: OutlineInputBorder(), labelText: 'Document / image type')),
        ]))),
        const SizedBox(height: VaayuSpacing.md),
        ClipRRect(borderRadius: BorderRadius.circular(18), child: AspectRatio(aspectRatio: _camera?.value.aspectRatio ?? 1.0, child: _captured != null ? Image.file(File(_captured!.path), fit: BoxFit.cover) : CameraPreview(_camera!))),
        const SizedBox(height: VaayuSpacing.sm),
        Text(_captured == null ? (_selectedDocument == 'VEHICLE_PHOTO' ? 'Frame the whole vehicle, but keep the number plate large, sharp and unobstructed.' : 'Place the entire document inside the frame. Avoid glare and keep all corners visible.') : 'The image is processed on-device first. Review the detected fields before submitting.', style: TextStyle(fontSize: 12, color: colors.textSecondary)),
        const SizedBox(height: VaayuSpacing.md),
        if (_captured != null) _buildExtractionCard(colors),
        if (_captured != null) const SizedBox(height: VaayuSpacing.md),
        Row(children: [
          Expanded(child: OutlinedButton.icon(onPressed: _capturing || _extracting ? null : (_captured == null ? _capture : _resetCapture), icon: Icon(_captured == null ? Icons.camera_alt : Icons.refresh), label: Text(_captured == null ? 'Capture & read' : 'Retake'))),
          const SizedBox(width: VaayuSpacing.sm),
          Expanded(child: FilledButton.icon(onPressed: _captured == null || _capturing || _extracting ? null : _upload, icon: _capturing ? const SizedBox(width: 18, height: 18, child: CircularProgressIndicator(strokeWidth: 2)) : const Icon(Icons.verified_user), label: Text(_capturing ? 'Processing…' : 'Submit securely'))),
        ]),
        const SizedBox(height: VaayuSpacing.lg),
        if (_kycSummary != null) Card(color: colors.surface, child: Padding(padding: const EdgeInsets.all(VaayuSpacing.md), child: Row(children: [Icon(Icons.fact_check_outlined, color: colors.primary), const SizedBox(width: VaayuSpacing.sm), Expanded(child: Text('KYC status: ${_kycSummary!['status'] ?? 'PENDING'}', style: TextStyle(fontWeight: FontWeight.w700, color: colors.textPrimary)))]))),
      ])),
    );
  }
}

class _ErrorState extends StatelessWidget {
  final String message;
  final VoidCallback onRetry;
  const _ErrorState({required this.message, required this.onRetry});
  @override Widget build(BuildContext context) => Center(child: Padding(padding: const EdgeInsets.all(24), child: Column(mainAxisSize: MainAxisSize.min, children: [const Icon(Icons.no_photography_outlined, size: 48), const SizedBox(height: 12), Text(message, textAlign: TextAlign.center), const SizedBox(height: 16), FilledButton(onPressed: onRetry, child: const Text('Try again'))])));
}