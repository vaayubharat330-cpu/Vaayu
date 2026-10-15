/// Domain Models for VAAYU Phase E4: Operations & Live Fleet Monitoring.
/// Represents authoritative backend fleet summaries, live driver states,
/// active trips, and exception-first operational alerts.
library operations_models;

enum AlertSeverity {
  critical,
  high,
  warning,
  medium,
  info
}

enum AlertType {
  dispatchTimeoutDelay,
  telemetrySignalLoss,
  tripSlaBreach,
  offerRejected,
  geofenceException,
  unspecified
}

class OperationalAlert {
  final String id;
  final AlertSeverity severity;
  final AlertType type;
  final String? orderId;
  final String? driverId;
  final String? driverName;
  final String? vehicleId;
  final int ageSec;
  final String message;
  final DateTime timestamp;

  const OperationalAlert({
    required this.id,
    required this.severity,
    required this.type,
    this.orderId,
    this.driverId,
    this.driverName,
    this.vehicleId,
    required this.ageSec,
    required this.message,
    required this.timestamp,
  });

  factory OperationalAlert.fromJson(Map<String, dynamic> json) {
    AlertSeverity sev;
    final sevStr = (json['severity'] as String? ?? 'INFO').toUpperCase();
    switch (sevStr) {
      case 'CRITICAL':
        sev = AlertSeverity.critical;
        break;
      case 'HIGH':
        sev = AlertSeverity.high;
        break;
      case 'WARNING':
        sev = AlertSeverity.warning;
        break;
      case 'MEDIUM':
        sev = AlertSeverity.medium;
        break;
      default:
        sev = AlertSeverity.info;
    }

    AlertType t;
    final typeStr = (json['type'] as String? ?? '').toUpperCase();
    switch (typeStr) {
      case 'DISPATCH_TIMEOUT_DELAY':
        t = AlertType.dispatchTimeoutDelay;
        break;
      case 'TELEMETRY_SIGNAL_LOSS':
        t = AlertType.telemetrySignalLoss;
        break;
      case 'TRIP_SLA_BREACH':
        t = AlertType.tripSlaBreach;
        break;
      case 'OFFER_REJECTED':
        t = AlertType.offerRejected;
        break;
      case 'GEOFENCE_EXCEPTION':
        t = AlertType.geofenceException;
        break;
      default:
        t = AlertType.unspecified;
    }

    return OperationalAlert(
      id: json['id'] as String? ?? 'ALT_${DateTime.now().millisecondsSinceEpoch}',
      severity: sev,
      type: t,
      orderId: json['orderId'] as String?,
      driverId: json['driverId'] as String?,
      driverName: json['driverName'] as String?,
      vehicleId: json['vehicleId'] as String?,
      ageSec: (json['ageSec'] as num?)?.toInt() ?? 0,
      message: json['message'] as String? ?? 'Operational alert generated',
      timestamp: json['timestamp'] != null
          ? DateTime.tryParse(json['timestamp'] as String) ?? DateTime.now()
          : DateTime.now(),
    );
  }
}

class FleetSummary {
  final int totalDrivers;
  final int onlineCount;
  final int degradedCount;
  final int staleCount;
  final int offlineCount;
  final int utilizationPercent;

  const FleetSummary({
    required this.totalDrivers,
    required this.onlineCount,
    required this.degradedCount,
    required this.staleCount,
    required this.offlineCount,
    required this.utilizationPercent,
  });

  factory FleetSummary.fromJson(Map<String, dynamic> json) {
    return FleetSummary(
      totalDrivers: (json['totalDrivers'] as num?)?.toInt() ?? 0,
      onlineCount: (json['onlineCount'] as num?)?.toInt() ?? 0,
      degradedCount: (json['degradedCount'] as num?)?.toInt() ?? 0,
      staleCount: (json['staleCount'] as num?)?.toInt() ?? 0,
      offlineCount: (json['offlineCount'] as num?)?.toInt() ?? 0,
      utilizationPercent: (json['utilizationPercent'] as num?)?.toInt() ?? 0,
    );
  }
}

class FleetDriverLive {
  final String driverId;
  final String name;
  final String phone;
  final String? vehicleId;
  final String? vehicleName;
  final String? vehicleNumber;
  final double rating;
  final String dutyStatus;
  final String livenessState; // ONLINE, DEGRADED, STALE, OFFLINE
  final double? lat;
  final double? lng;
  final double? speed;
  final int? pingAgeSec;
  final bool isReserved;
  final String? reservedOrderId;

  const FleetDriverLive({
    required this.driverId,
    required this.name,
    required this.phone,
    this.vehicleId,
    this.vehicleName,
    this.vehicleNumber,
    required this.rating,
    required this.dutyStatus,
    required this.livenessState,
    this.lat,
    this.lng,
    this.speed,
    this.pingAgeSec,
    required this.isReserved,
    this.reservedOrderId,
  });

  factory FleetDriverLive.fromJson(Map<String, dynamic> json) {
    return FleetDriverLive(
      driverId: json['driverId'] as String? ?? json['userId'] as String? ?? '',
      name: json['name'] as String? ?? 'Driver Partner',
      phone: json['phone'] as String? ?? '',
      vehicleId: json['vehicleId'] as String?,
      vehicleName: json['vehicleName'] as String?,
      vehicleNumber: json['vehicleNumber'] as String?,
      rating: (json['rating'] as num?)?.toDouble() ?? 4.8,
      dutyStatus: json['dutyStatus'] as String? ?? 'OFFLINE',
      livenessState: json['livenessState'] as String? ?? 'OFFLINE',
      lat: (json['lat'] as num?)?.toDouble(),
      lng: (json['lng'] as num?)?.toDouble(),
      speed: (json['speed'] as num?)?.toDouble(),
      pingAgeSec: (json['pingAgeSec'] as num?)?.toInt(),
      isReserved: json['isReserved'] as bool? ?? false,
      reservedOrderId: json['reservedOrderId'] as String?,
    );
  }
}

class ActiveTripSummary {
  final String id;
  final String status;
  final String? customerName;
  final String? customerPhone;
  final String? driverId;
  final String? driverName;
  final String pickupAddress;
  final String dropoffAddress;
  final double totalFare;
  final int waitingTimeSec;
  final String? liveEta;
  final bool reservationLockActive;

  const ActiveTripSummary({
    required this.id,
    required this.status,
    this.customerName,
    this.customerPhone,
    this.driverId,
    this.driverName,
    required this.pickupAddress,
    required this.dropoffAddress,
    required this.totalFare,
    required this.waitingTimeSec,
    this.liveEta,
    required this.reservationLockActive,
  });

  factory ActiveTripSummary.fromJson(Map<String, dynamic> json) {
    final cust = json['customer'] as Map<String, dynamic>?;
    final drv = json['driver'] as Map<String, dynamic>?;
    final pickup = json['pickup'] as Map<String, dynamic>?;
    final dropoff = json['dropoff'] as Map<String, dynamic>?;
    final fareBreakdown = json['fareBreakdown'] as Map<String, dynamic>?;

    final fareVal = (json['totalFare'] as num?)?.toDouble() ??
        (fareBreakdown?['total'] as num?)?.toDouble() ??
        0.0;

    return ActiveTripSummary(
      id: json['id'] as String? ?? '',
      status: json['status'] as String? ?? 'UNKNOWN',
      customerName: cust?['name'] as String? ?? 'Rider',
      customerPhone: cust?['phone'] as String?,
      driverId: drv?['id'] as String? ?? drv?['userId'] as String?,
      driverName: drv?['name'] as String?,
      pickupAddress: pickup?['address'] as String? ?? 'Pickup Location',
      dropoffAddress: dropoff?['address'] as String? ?? 'Destination Location',
      totalFare: fareVal,
      waitingTimeSec: (json['waitingTimeSec'] as num?)?.toInt() ?? 0,
      liveEta: json['liveEta'] is Map
          ? (json['liveEta'] as Map)['formatted'] as String?
          : json['liveEta'] as String?,
      reservationLockActive: json['reservationLockActive'] as bool? ?? false,
    );
  }
}
