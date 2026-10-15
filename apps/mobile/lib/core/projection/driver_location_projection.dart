/// High-frequency driver location projection.
///
/// This is deliberately independent from LocalTripProjection.version.
/// Trip state versions describe discrete authoritative state transitions;
/// location uses its own monotonic sequence/timestamp domain.
class DriverLocationProjection {
  final String tripId;
  final double latitude;
  final double longitude;
  final double? accuracyMeters;
  final DateTime receivedAt;
  final DateTime? serverTimestamp;
  final int? sequence;

  const DriverLocationProjection({
    required this.tripId,
    required this.latitude,
    required this.longitude,
    this.accuracyMeters,
    required this.receivedAt,
    this.serverTimestamp,
    this.sequence,
  });

  DateTime get orderingTime => serverTimestamp ?? receivedAt;

  bool isNewerThan(DriverLocationProjection? current) {
    if (current == null) return true;

    if (current.sequence != null) {
      if (sequence == null) return false;
      return sequence! > current.sequence!;
    }

    if (sequence != null) return true;
    return orderingTime.isAfter(current.orderingTime);
  }

  Map<String, dynamic> toJson() => {
        'tripId': tripId,
        'latitude': latitude,
        'longitude': longitude,
        'accuracyMeters': accuracyMeters,
        'receivedAt': receivedAt.toIso8601String(),
        'serverTimestamp': serverTimestamp?.toIso8601String(),
        'sequence': sequence,
      };
}
