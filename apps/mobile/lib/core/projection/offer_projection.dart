/// Client-side projection of a server-dispatched driver offer.
///
/// The client may use this for display/countdown only. Acceptance validity is
/// always decided by the backend.
class OfferProjection {
  final String offerId;
  final String orderId;
  final Map<String, dynamic> payload;
  final DateTime receivedAt;
  final DateTime? expiresAt;
  final DateTime? serverTimeAtReceipt;

  const OfferProjection({
    required this.offerId,
    required this.orderId,
    required this.payload,
    required this.receivedAt,
    this.expiresAt,
    this.serverTimeAtReceipt,
  });

  /// Estimated server clock offset. Positive means the server is ahead.
  Duration get serverClockOffset {
    if (serverTimeAtReceipt == null) return Duration.zero;
    return serverTimeAtReceipt!.difference(receivedAt);
  }

  /// UI-only expiry estimate using the server clock domain when available.
  /// Never use this to authorize acceptance locally.
  bool isExpiredAt(DateTime clientNow) {
    if (expiresAt == null) return false;
    final estimatedServerNow = clientNow.add(serverClockOffset);
    return !estimatedServerNow.isBefore(expiresAt!);
  }

  /// UI-only countdown remaining seconds using estimated server time.
  int remainingSeconds(DateTime clientNow) {
    if (expiresAt == null) return 0;
    final estimatedServerNow = clientNow.add(serverClockOffset);
    final diff = expiresAt!.difference(estimatedServerNow).inSeconds;
    return diff > 0 ? diff : 0;
  }
}
