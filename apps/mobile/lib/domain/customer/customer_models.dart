/// Models representing Customer domain trip requests, estimates, and bookings.
library customer_models;

class TripEstimateRequest {
  final double pickupLat;
  final double pickupLng;
  final double dropLat;
  final double dropLng;
  final String? vehicleId;
  final int helperCount;
  final int extraDropsCount;
  final bool isOutstation;
  final int waitingTimeMinutes;

  const TripEstimateRequest({
    required this.pickupLat,
    required this.pickupLng,
    required this.dropLat,
    required this.dropLng,
    this.vehicleId,
    this.helperCount = 0,
    this.extraDropsCount = 0,
    this.isOutstation = false,
    this.waitingTimeMinutes = 0,
  });

  Map<String, dynamic> toJson() {
    return {
      'pickupLat': pickupLat,
      'pickupLng': pickupLng,
      'dropLat': dropLat,
      'dropLng': dropLng,
      if (vehicleId != null) 'vehicleId': vehicleId,
      'helperCount': helperCount,
      'extraDropsCount': extraDropsCount,
      'isOutstation': isOutstation,
      'waitingTimeMinutes': waitingTimeMinutes,
    };
  }
}

class FareEstimateResult {
  final bool success;
  final double? estimatedFare;
  final double? distanceKm;
  final double? durationMins;
  final String? vehicleId;
  final Map<String, dynamic>? fareBreakdown;
  final String? error;

  const FareEstimateResult({
    required this.success,
    this.estimatedFare,
    this.distanceKm,
    this.durationMins,
    this.vehicleId,
    this.fareBreakdown,
    this.error,
  });

  factory FareEstimateResult.fromJson(Map<String, dynamic> json) {
    return FareEstimateResult(
      success: json['success'] == true,
      estimatedFare: json['estimatedFare'] != null ? (json['estimatedFare'] as num).toDouble() : null,
      distanceKm: json['distanceKm'] != null ? (json['distanceKm'] as num).toDouble() : null,
      durationMins: json['durationMins'] != null ? (json['durationMins'] as num).toDouble() : null,
      vehicleId: json['vehicleId'] as String?,
      fareBreakdown: json['fareBreakdown'] as Map<String, dynamic>?,
      error: json['error'] as String?,
    );
  }
}

class CreateBookingRequest {
  final String idempotencyKey;
  final double pickupLat;
  final double pickupLng;
  final String pickupAddress;
  final double dropLat;
  final double dropLng;
  final String dropAddress;
  final String vehicleId;
  final String? notes;
  final int helperCount;
  final int extraDropsCount;
  final bool isOutstation;

  const CreateBookingRequest({
    required this.idempotencyKey,
    required this.pickupLat,
    required this.pickupLng,
    required this.pickupAddress,
    required this.dropLat,
    required this.dropLng,
    required this.dropAddress,
    required this.vehicleId,
    this.notes,
    this.helperCount = 0,
    this.extraDropsCount = 0,
    this.isOutstation = false,
  });

  CreateBookingRequest copyWith({
    String? idempotencyKey,
    double? pickupLat,
    double? pickupLng,
    String? pickupAddress,
    double? dropLat,
    double? dropLng,
    String? dropAddress,
    String? vehicleId,
    String? notes,
    int? helperCount,
    int? extraDropsCount,
    bool? isOutstation,
  }) {
    return CreateBookingRequest(
      idempotencyKey: idempotencyKey ?? this.idempotencyKey,
      pickupLat: pickupLat ?? this.pickupLat,
      pickupLng: pickupLng ?? this.pickupLng,
      pickupAddress: pickupAddress ?? this.pickupAddress,
      dropLat: dropLat ?? this.dropLat,
      dropLng: dropLng ?? this.dropLng,
      dropAddress: dropAddress ?? this.dropAddress,
      vehicleId: vehicleId ?? this.vehicleId,
      notes: notes ?? this.notes,
      helperCount: helperCount ?? this.helperCount,
      extraDropsCount: extraDropsCount ?? this.extraDropsCount,
      isOutstation: isOutstation ?? this.isOutstation,
    );
  }

  Map<String, dynamic> toJson() {
    return {
      'idempotencyKey': idempotencyKey,
      'pickupLat': pickupLat,
      'pickupLng': pickupLng,
      'pickupAddress': pickupAddress,
      'dropLat': dropLat,
      'dropLng': dropLng,
      'dropAddress': dropAddress,
      'vehicleId': vehicleId,
      if (notes != null) 'notes': notes,
      'helperCount': helperCount,
      'extraDropsCount': extraDropsCount,
      'isOutstation': isOutstation,
    };
  }
}
