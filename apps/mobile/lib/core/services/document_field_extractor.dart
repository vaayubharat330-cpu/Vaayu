import 'package:google_mlkit_text_recognition/google_mlkit_text_recognition.dart';

class DocumentExtractionResult {
  final String documentType;
  final String rawText;
  final Map<String, String> fields;
  final List<String> warnings;

  const DocumentExtractionResult({
    required this.documentType,
    required this.rawText,
    required this.fields,
    required this.warnings,
  });

  bool get hasUsefulFields => fields.isNotEmpty;

  Map<String, dynamic> toJson() => {
        'documentType': documentType,
        'fields': fields,
        'warnings': warnings,
        'rawTextAvailable': rawText.isNotEmpty,
      };
}

class DocumentFieldExtractor {
  final TextRecognizer _recognizer = TextRecognizer(
    script: TextRecognitionScript.latin,
  );

  Future<DocumentExtractionResult> extract({
    required String imagePath,
    required String documentType,
  }) async {
    if (documentType == 'PROFILE_PHOTO') {
      return const DocumentExtractionResult(
        documentType: 'PROFILE_PHOTO',
        rawText: '',
        fields: {},
        warnings: [],
      );
    }

    final input = InputImage.fromFilePath(imagePath);
    final recognized = await _recognizer.processImage(input);
    final raw = recognized.text.replaceAll('\u00a0', ' ').trim();
    final normalized = _normalize(raw);
    final fields = <String, String>{};
    final warnings = <String>[];

    switch (documentType) {
      case 'VEHICLE_PHOTO':
        final plate = _extractVehicleRegistration(normalized);
        if (plate != null) {
          fields['vehicleNumber'] = plate;
        } else {
          warnings.add('Number plate could not be read clearly. Retake with the plate filling more of the frame.');
        }
        break;
      case 'RC':
        _put(fields, 'vehicleNumber', _extractVehicleRegistration(normalized));
        _put(fields, 'ownerName', _extractAfterLabel(raw, const ['owner name', 'name of owner', 'registered owner']));
        _put(fields, 'vehicleClass', _extractAfterLabel(raw, const ['class of vehicle', 'vehicle class']));
        _put(fields, 'fuelType', _extractAfterLabel(raw, const ['fuel', 'fuel type']));
        _put(fields, 'registrationDate', _extractDateAfterLabel(raw, const ['registration date', 'date of registration']));
        _put(fields, 'insuranceValidUntil', _extractDateAfterLabel(raw, const ['insurance valid upto', 'insurance valid up to', 'insurance validity']));
        _put(fields, 'puccValidUntil', _extractDateAfterLabel(raw, const ['pucc valid upto', 'pucc valid up to', 'pollution valid up to']));
        _put(fields, 'chassisLast5', _extractTailAfterLabel(raw, const ['chassis no', 'chassis number'], 5));
        _put(fields, 'engineLast5', _extractTailAfterLabel(raw, const ['engine no', 'engine number'], 5));
        _warnMissing(warnings, fields, 'vehicleNumber', 'RC registration number was not detected.');
        break;
      case 'DRIVING_LICENSE':
        _put(fields, 'licenseNumber', _extractDrivingLicenseNumber(normalized));
        _put(fields, 'name', _extractAfterLabel(raw, const ['name', 'name of holder', 'holder name']));
        _put(fields, 'dateOfBirth', _extractDateAfterLabel(raw, const ['date of birth', 'dob', 'birth']));
        _put(fields, 'issueDate', _extractDateAfterLabel(raw, const ['issue date', 'date of issue']));
        _put(fields, 'validUntil', _extractDateAfterLabel(raw, const ['valid till', 'validity', 'valid up to', 'valid upto']));
        _put(fields, 'transportValidUntil', _extractDateAfterLabel(raw, const ['transport validity', 'transport valid']));
        _put(fields, 'licensingAuthority', _extractAfterLabel(raw, const ['licensing authority', 'issuing authority']));
        _warnMissing(warnings, fields, 'licenseNumber', 'Driving licence number was not detected.');
        break;
      case 'INSURANCE':
        _put(fields, 'policyNumber', _extractPolicyNumber(normalized));
        _put(fields, 'vehicleNumber', _extractVehicleRegistration(normalized));
        _put(fields, 'insurer', _extractAfterLabel(raw, const ['insurer', 'insurance company', 'company name']));
        _put(fields, 'policyStartDate', _extractDateAfterLabel(raw, const ['period of insurance', 'policy start', 'start date', 'from']));
        _put(fields, 'policyEndDate', _extractDateAfterLabel(raw, const ['policy end', 'end date', 'to', 'valid up to']));
        _warnMissing(warnings, fields, 'policyNumber', 'Insurance policy number was not detected.');
        break;
      case 'PAN':
        _put(fields, 'panNumber', _extractPan(normalized));
        _put(fields, 'name', _extractAfterLabel(raw, const ['name', 'name of assessee']));
        _put(fields, 'dateOfBirth', _extractDateAfterLabel(raw, const ['date of birth', 'dob']));
        _warnMissing(warnings, fields, 'panNumber', 'PAN number was not detected.');
        break;
      case 'AADHAAR':
        _put(fields, 'name', _extractAfterLabel(raw, const ['name']));
        _put(fields, 'dateOfBirth', _extractDateAfterLabel(raw, const ['dob', 'date of birth', 'year of birth']));
        final masked = _extractAadhaar(normalized);
        if (masked != null) {
          fields['aadhaarLast4'] = masked;
        } else {
          warnings.add('Aadhaar number was not detected. The app stores only the last four digits, never the full Aadhaar number.');
        }
        break;
      default:
        break;
    }

    return DocumentExtractionResult(
      documentType: documentType,
      rawText: raw,
      fields: fields,
      warnings: warnings,
    );
  }

  void _put(Map<String, String> target, String key, String? value) {
    if (value != null && value.trim().isNotEmpty) {
      target[key] = value.trim();
    }
  }

  void _warnMissing(List<String> warnings, Map<String, String> fields, String key, String message) {
    if (!fields.containsKey(key)) {
      warnings.add(message);
    }
  }

  String _normalize(String value) => value
      .toUpperCase()
      .replaceAll(RegExp(r'[|]'), 'I')
      .replaceAll(RegExp(r'[^A-Z0-9\s/-]'), ' ')
      .replaceAll(RegExp(r'\s+'), ' ')
      .trim();

  String? _extractVehicleRegistration(String text) {
    final candidates = RegExp(r'\b(?:[A-Z]{2}[ -]?\d{1,2}[ -]?[A-Z]{1,3}[ -]?\d{4}|\d{2}[ -]?BH[ -]?\d{4}[ -]?[A-Z]{1,2})\b')
        .allMatches(text)
        .map((m) => _cleanPlate(m.group(0)!))
        .where((v) => v.length >= 7)
        .toList();
    if (candidates.isEmpty) return null;
    candidates.sort((a, b) => b.length.compareTo(a.length));
    return candidates.first;
  }

  String _cleanPlate(String value) => value.replaceAll(RegExp(r'[^A-Z0-9]'), '');

  String? _extractDrivingLicenseNumber(String text) {
    final match = RegExp(r'\b[A-Z]{1,3}[ -]?[A-Z0-9]{8,16}\b').firstMatch(text);
    return match?.group(0)?.replaceAll(RegExp(r'[^A-Z0-9]'), '');
  }

  String? _extractPolicyNumber(String text) {
    final labeled = RegExp(r'(?:POLICY(?:\s+NO|\s+NUMBER)?|POLICYNUMBER)\s*[:#-]?\s*([A-Z0-9/-]{6,30})').firstMatch(text);
    return labeled?.group(1)?.replaceAll(RegExp(r'\s'), '');
  }

  String? _extractPan(String text) {
    return RegExp(r'\b[A-Z]{5}[0-9]{4}[A-Z]\b').firstMatch(text)?.group(0);
  }

  String? _extractAadhaar(String text) {
    final groups = RegExp(r'\b\d{4}[ -]\d{4}[ -]\d{4}\b').firstMatch(text);
    if (groups != null) {
      return groups.group(0)!.replaceAll(RegExp(r'[^0-9]'), '').substring(8);
    }
    final compact = RegExp(r'\b\d{12}\b').firstMatch(text);
    if (compact != null) {
      return compact.group(0)!.substring(8);
    }
    return null;
  }

  String? _extractAfterLabel(String raw, List<String> labels) {
    for (final label in labels) {
      final pattern = RegExp('${RegExp.escape(label)}\\s*[:#-]?\\s*([^\\n]{2,100})', caseSensitive: false);
      final match = pattern.firstMatch(raw);
      if (match != null) {
        final value = match.group(1)!.trim().replaceAll(RegExp(r'\s+'), ' ');
        if (value.isNotEmpty) return value;
      }
    }
    return null;
  }

  String? _extractDateAfterLabel(String raw, List<String> labels) {
    for (final label in labels) {
      final pattern = RegExp('${RegExp.escape(label)}\\s*[:#-]?\\s*([0-9]{1,4}[/-][0-9]{1,2}[/-][0-9]{1,4})', caseSensitive: false);
      final match = pattern.firstMatch(raw);
      if (match != null) return match.group(1);
    }
    final generic = RegExp(r'\b(?:0?[1-9]|[12][0-9]|3[01])[/-](?:0?[1-9]|1[0-2])[/-](?:19|20)\d{2}\b').firstMatch(raw);
    return generic?.group(0);
  }

  String? _extractTailAfterLabel(String raw, List<String> labels, int length) {
    final value = _extractAfterLabel(raw, labels);
    if (value == null) return null;
    final cleaned = value.toUpperCase().replaceAll(RegExp(r'[^A-Z0-9]'), '');
    if (cleaned.length < length) return null;
    return cleaned.substring(cleaned.length - length);
  }

  void dispose() => _recognizer.close();
}