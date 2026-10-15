/// Persistent Pending Mutation Model
/// Invariant: Retains the identical UUIDv4 idempotencyKey across app restarts and network timeouts.
class PendingMutation {
  final String intentId;
  final String idempotencyKey;
  final String operation; // e.g. 'accept', 'start-arriving', 'confirm-pickup', 'complete'
  final String tripId;
  final Map<String, dynamic> payload;
  final DateTime createdAt;
  final int retryCount;

  const PendingMutation({
    required this.intentId,
    required this.idempotencyKey,
    required this.operation,
    required this.tripId,
    required this.payload,
    required this.createdAt,
    this.retryCount = 0,
  });

  PendingMutation copyWithRetry() {
    return PendingMutation(
      intentId: intentId,
      idempotencyKey: idempotencyKey, // Retained!
      operation: operation,
      tripId: tripId,
      payload: payload,
      createdAt: createdAt,
      retryCount: retryCount + 1,
    );
  }

  Map<String, dynamic> toJson() => {
        'intentId': intentId,
        'idempotencyKey': idempotencyKey,
        'operation': operation,
        'tripId': tripId,
        'payload': payload,
        'createdAt': createdAt.toIso8601String(),
        'retryCount': retryCount,
      };

  factory PendingMutation.fromJson(Map<String, dynamic> json) => PendingMutation(
        intentId: json['intentId'] as String,
        idempotencyKey: json['idempotencyKey'] as String,
        operation: json['operation'] as String,
        tripId: json['tripId'] as String,
        payload: json['payload'] as Map<String, dynamic>,
        createdAt: DateTime.parse(json['createdAt'] as String),
        retryCount: json['retryCount'] as int? ?? 0,
      );
}
