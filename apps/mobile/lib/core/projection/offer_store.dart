import 'dart:async';
import 'offer_projection.dart';

/// Multi-offer projection store for driver dispatch offers.
class OfferStore {
  final Map<String, OfferProjection> _offers = {};
  final StreamController<OfferProjection> _controller =
      StreamController<OfferProjection>.broadcast();

  Stream<OfferProjection> get offersStream => _controller.stream;
  OfferProjection? getOffer(String offerId) => _offers[offerId];
  Map<String, OfferProjection> get snapshot => Map.unmodifiable(_offers);

  void upsert(OfferProjection offer) {
    _offers[offer.offerId] = offer;
    _controller.add(offer);
  }

  void remove(String offerId) => _offers.remove(offerId);

  void clear() => _offers.clear();

  Future<void> dispose() => _controller.close();
}
