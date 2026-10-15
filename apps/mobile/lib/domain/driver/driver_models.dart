/// Models representing Driver domain entities and state transitions.
library driver_models;

class DriverOffer {
  final String orderId;
  final double pickupLat;
  final double pickupLng;
  final String pickupAddress;
  final double dropLat;
  final double dropLng;
  final String dropAddress;
  final double estimatedFare;
  final double distanceKm;
  final DateTime expiresAt;

  const DriverOffer({
    required this.orderId,
    required this.pickupLat,
    required this.pickupLng,
    required this.pickupAddress,
    required this.dropLat,
    required this.dropLng,
    required this.dropAddress,
    required this.estimatedFare,
    required this.distanceKm,
    required this.expiresAt,
  });

  factory DriverOffer.fromJson(Map<String, dynamic> json) {
    return DriverOffer(
      orderId: json['orderId']?.toString() ?? json['id']?.toString() ?? '',
      pickupLat: (json['pickupLat'] as num?)?.toDouble() ?? 0.0,
      pickupLng: (json['pickupLng'] as num?)?.toDouble() ?? 0.0,
      pickupAddress: json['pickupAddress']?.toString() ?? '',
      dropLat: (json['dropLat'] as num?)?.toDouble() ?? 0.0,
      dropLng: (json['dropLng'] as num?)?.toDouble() ?? 0.0,
      dropAddress: json['dropAddress']?.toString() ?? '',
      estimatedFare: (json['estimatedFare'] as num?)?.toDouble() ?? 0.0,
      distanceKm: (json['distanceKm'] as num?)?.toDouble() ?? 0.0,
      expiresAt: json['expiresAt'] != null
          ? DateTime.tryParse(json['expiresAt'].toString()) ?? DateTime.now()
          : DateTime.now().add(const Duration(seconds: 30)),
    );
  }

  int remainingSeconds([Duration offset = Duration.zero]) {
    final now = DateTime.now().add(offset);
    final diff = expiresAt.difference(now).inSeconds;
    return diff > 0 ? diff : 0;
  }
}

class DriverProfile {
  final String id;
  final String name;
  final String phone;
  final String status;
  final double rating;
  final double todayEarnings;
  final int todayTrips;
  final double pocketBalance;
  final String? vehiclePlate;
  final String? vehicleId;

  const DriverProfile({
    required this.id,
    required this.name,
    required this.phone,
    required this.status,
    required this.rating,
    required this.todayEarnings,
    required this.todayTrips,
    required this.pocketBalance,
    this.vehiclePlate,
    this.vehicleId,
  });

  factory DriverProfile.fromJson(Map<String, dynamic> json) {
    return DriverProfile(
      id: json['partner_id']?.toString() ?? json['id']?.toString() ?? '',
      name: json['name']?.toString() ?? '',
      phone: json['phone']?.toString() ?? '',
      status: json['status']?.toString() ?? 'OFFLINE',
      rating: double.tryParse(json['rating']?.toString() ?? '5.0') ?? 5.0,
      todayEarnings: (json['today_earnings'] as num?)?.toDouble() ?? 0.0,
      todayTrips: (json['today_trips'] as num?)?.toInt() ?? 0,
      pocketBalance: (json['pocket_balance'] as num?)?.toDouble() ?? 0.0,
      vehiclePlate: json['vehicle_plate']?.toString() ?? json['vehicle_number']?.toString(),
      vehicleId: json['vehicle_id']?.toString(),
    );
  }

  DriverProfile copyWith({
    String? id,
    String? name,
    String? phone,
    String? status,
    double? rating,
    double? todayEarnings,
    int? todayTrips,
    double? pocketBalance,
    String? vehiclePlate,
    String? vehicleId,
  }) {
    return DriverProfile(
      id: id ?? this.id,
      name: name ?? this.name,
      phone: phone ?? this.phone,
      status: status ?? this.status,
      rating: rating ?? this.rating,
      todayEarnings: todayEarnings ?? this.todayEarnings,
      todayTrips: todayTrips ?? this.todayTrips,
      pocketBalance: pocketBalance ?? this.pocketBalance,
      vehiclePlate: vehiclePlate ?? this.vehiclePlate,
      vehicleId: vehicleId ?? this.vehicleId,
    );
  }
}
