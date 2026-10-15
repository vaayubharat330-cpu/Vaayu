/// Immutable Read-Only Projection of Server Trip State
/// INVARIANT: This is strictly a local view model projection of backend truth.
/// It NEVER executes dispatch scoring, ledger calculations, or state transitions locally.
const Object _unset = Object();

class LocalTripProjection {
  final String tripId;
  final String status;
  final int version; // Monotonic server version
  final String? customerId;
  final String? driverId;
  final String? driverName;
  final String? driverPhone;
  final double? driverLat;
  final double? driverLng;
  final double pickupLat;
  final double pickupLng;
  final double dropLat;
  final double dropLng;
  final int? etaMinutes;
  final double totalFare;
  final String? pickupOtp;
  final String? deliveryOtp;
  final String? podPhotoUrl;
  final DateTime updatedAt;
  final bool isOptimistic;

  const LocalTripProjection({
    required this.tripId,
    required this.status,
    required this.version,
    this.customerId,
    this.driverId,
    this.driverName,
    this.driverPhone,
    this.driverLat,
    this.driverLng,
    required this.pickupLat,
    required this.pickupLng,
    required this.dropLat,
    required this.dropLng,
    this.etaMinutes,
    required this.totalFare,
    this.pickupOtp,
    this.deliveryOtp,
    this.podPhotoUrl,
    required this.updatedAt,
    this.isOptimistic = false,
  });

  /// Monotonic Update Invariant:
  /// incomingVersion > currentVersion -> Apply
  /// incomingVersion <= currentVersion -> Discard
  bool shouldApplyUpdate(int incomingVersion) {
    return incomingVersion > version;
  }

  /// Copy with updated fields for optimistic UI decorators.
  ///
  /// Nullable fields use a private sentinel so callers can explicitly clear
  /// driver coordinates/ETA instead of null meaning "leave unchanged".
  LocalTripProjection copyWith({
    String? status,
    int? version,
    Object? driverLat = _unset,
    Object? driverLng = _unset,
    Object? etaMinutes = _unset,
    bool? isOptimistic,
    DateTime? updatedAt,
  }) {
    return LocalTripProjection(
      tripId: tripId,
      status: status ?? this.status,
      version: version ?? this.version,
      customerId: customerId,
      driverId: driverId,
      driverName: driverName,
      driverPhone: driverPhone,
      driverLat: identical(driverLat, _unset) ? this.driverLat : driverLat as double?,
      driverLng: identical(driverLng, _unset) ? this.driverLng : driverLng as double?,
      pickupLat: pickupLat,
      pickupLng: pickupLng,
      dropLat: dropLat,
      dropLng: dropLng,
      etaMinutes: identical(etaMinutes, _unset) ? this.etaMinutes : etaMinutes as int?,
      totalFare: totalFare,
      pickupOtp: pickupOtp,
      deliveryOtp: deliveryOtp,
      podPhotoUrl: podPhotoUrl,
      updatedAt: updatedAt ?? this.updatedAt,
      isOptimistic: isOptimistic ?? this.isOptimistic,
    );
  }

  Map<String, dynamic> toJson() => {
        'tripId': tripId,
        'status': status,
        'version': version,
        'customerId': customerId,
        'driverId': driverId,
        'driverName': driverName,
        'driverPhone': driverPhone,
        'driverLat': driverLat,
        'driverLng': driverLng,
        'pickupLat': pickupLat,
        'pickupLng': pickupLng,
        'dropLat': dropLat,
        'dropLng': dropLng,
        'etaMinutes': etaMinutes,
        'totalFare': totalFare,
        'pickupOtp': pickupOtp,
        'deliveryOtp': deliveryOtp,
        'podPhotoUrl': podPhotoUrl,
        'updatedAt': updatedAt.toIso8601String(),
        'isOptimistic': isOptimistic,
      };

  factory LocalTripProjection.fromJson(Map<String, dynamic> json) =>
      LocalTripProjection(
        tripId: json['tripId'] as String,
        status: json['status'] as String,
        version: json['version'] as int? ?? 1,
        customerId: json['customerId'] as String?,
        driverId: json['driverId'] as String?,
        driverName: json['driverName'] as String?,
        driverPhone: json['driverPhone'] as String?,
        driverLat: (json['driverLat'] as num?)?.toDouble(),
        driverLng: (json['driverLng'] as num?)?.toDouble(),
        pickupLat: (json['pickupLat'] as num).toDouble(),
        pickupLng: (json['pickupLng'] as num).toDouble(),
        dropLat: (json['dropLat'] as num).toDouble(),
        dropLng: (json['dropLng'] as num).toDouble(),
        etaMinutes: json['etaMinutes'] as int?,
        totalFare: (json['totalFare'] as num).toDouble(),
        pickupOtp: json['pickupOtp'] as String?,
        deliveryOtp: json['deliveryOtp'] as String?,
        podPhotoUrl: json['podPhotoUrl'] as String?,
        updatedAt: DateTime.parse(json['updatedAt'] as String),
        isOptimistic: json['isOptimistic'] as bool? ?? false,
      );
}
