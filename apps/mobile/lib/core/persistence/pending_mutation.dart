/// Persistent Pending Mutation Model.
///
/// Invariants:
/// - `idempotencyKey` never changes across retries or app restarts.
/// - retry scheduling is persisted so reconnects cannot create a hot retry loop.
/// - the original `createdAt` is retained for deterministic FIFO ordering.
class PendingMutation {
  final String intentId;
  final String idempotencyKey;
  final String operation;
  final String tripId;
  final Map<String, dynamic> payload;
  final DateTime createdAt;
  final int retryCount;
  final DateTime? nextAttemptAt;
  final String? lastErrorCode;
  final DateTime? lastFailureAt;

  const PendingMutation({
    required this.intentId,
    required this.idempotencyKey,
    required this.operation,
    required this.tripId,
    required this.payload,
    required this.createdAt,
    this.retryCount = 0,
    this.nextAttemptAt,
    this.lastErrorCode,
    this.lastFailureAt,
  });

  PendingMutation copyWithRetry({
    DateTime? nextAttemptAt,
    String? lastErrorCode,
    DateTime? lastFailureAt,
  }) {
    return PendingMutation(
      intentId: intentId,
      idempotencyKey: idempotencyKey,
      operation: operation,
      tripId: tripId,
      payload: payload,
      createdAt: createdAt,
      retryCount: retryCount + 1,
      nextAttemptAt: nextAttemptAt,
      lastErrorCode: lastErrorCode,
      lastFailureAt: lastFailureAt,
    );
  }

  bool get isReadyForReplay =>
      nextAttemptAt == null || !DateTime.now().toUtc().isBefore(nextAttemptAt!.toUtc());

  Map<String, dynamic> toJson() => {
        'intentId': intentId,
        'idempotencyKey': idempotencyKey,
        'operation': operation,
        'tripId': tripId,
        'payload': payload,
        'createdAt': createdAt.toIso8601String(),
        'retryCount': retryCount,
        if (nextAttemptAt != null) 'nextAttemptAt': nextAttemptAt!.toIso8601String(),
        if (lastErrorCode != null) 'lastErrorCode': lastErrorCode,
        if (lastFailureAt != null) 'lastFailureAt': lastFailureAt!.toIso8601String(),
      };

  factory PendingMutation.fromJson(Map<String, dynamic> json) => PendingMutation(
        intentId: json['intentId'] as String,
        idempotencyKey: json['idempotencyKey'] as String,
        operation: json['operation'] as String,
        tripId: json['tripId'] as String,
        payload: Map<String, dynamic>.from(json['payload'] as Map),
        createdAt: DateTime.parse(json['createdAt'] as String),
        retryCount: (json['retryCount'] as num?)?.toInt() ?? 0,
        nextAttemptAt: json['nextAttemptAt'] == null ? null : DateTime.parse(json['nextAttemptAt'] as String),
        lastErrorCode: json['lastErrorCode'] as String?,
        lastFailureAt: json['lastFailureAt'] == null ? null : DateTime.parse(json['lastFailureAt'] as String),
      );
}
