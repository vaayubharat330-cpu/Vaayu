import 'dart:async';
import 'package:flutter/widgets.dart';

/// Mobile Application Lifecycle States (Mirroring Flutter AppLifecycleState)
enum MobileLifecycleState {
  resumed,   // Foreground & active
  inactive,  // Transitional (e.g. system modal, incoming call)
  paused,    // Backgrounded
  detached,  // Suspended or terminating
}

/// Observer bridging Flutter's WidgetsBindingObserver to AppLifecycleManager
class AppLifecycleObserver with WidgetsBindingObserver {
  final AppLifecycleManager lifecycleManager;

  AppLifecycleObserver({required this.lifecycleManager});

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    final mobileState = mapState(state);
    lifecycleManager.handleLifecycleTransition(mobileState);
  }

  static MobileLifecycleState mapState(AppLifecycleState state) {
    switch (state) {
      case AppLifecycleState.resumed:
        return MobileLifecycleState.resumed;
      case AppLifecycleState.inactive:
        return MobileLifecycleState.inactive;
      case AppLifecycleState.paused:
        return MobileLifecycleState.paused;
      case AppLifecycleState.detached:
      case AppLifecycleState.hidden:
        return MobileLifecycleState.detached;
    }
  }
}

/// App Lifecycle Manager
/// Manages OS-level lifecycle transitions and broadcasts events to transport and resync coordinators.
class AppLifecycleManager {
  MobileLifecycleState _currentState = MobileLifecycleState.resumed;
  final StreamController<MobileLifecycleState> _stateController =
      StreamController<MobileLifecycleState>.broadcast();

  final List<Future<void> Function()> _onForegroundListeners = [];
  final List<Future<void> Function()> _onBackgroundListeners = [];

  MobileLifecycleState get currentState => _currentState;
  bool get isForeground => _currentState == MobileLifecycleState.resumed;
  Stream<MobileLifecycleState> get stateStream => _stateController.stream;

  void addOnForegroundListener(Future<void> Function() listener) {
    _onForegroundListeners.add(listener);
  }

  void addOnBackgroundListener(Future<void> Function() listener) {
    _onBackgroundListeners.add(listener);
  }

  /// Ingests OS-level lifecycle transition (from WidgetsBindingObserver)
  Future<void> handleLifecycleTransition(MobileLifecycleState newState) async {
    if (_currentState == newState) return;

    final wasBackground = _currentState == MobileLifecycleState.paused ||
        _currentState == MobileLifecycleState.detached;
    _currentState = newState;
    _stateController.add(newState);

    if (newState == MobileLifecycleState.resumed && wasBackground) {
      // Transition from background to foreground
      for (final listener in _onForegroundListeners) {
        await listener();
      }
    } else if (newState == MobileLifecycleState.paused ||
        newState == MobileLifecycleState.detached) {
      // Transition to background
      for (final listener in _onBackgroundListeners) {
        await listener();
      }
    }
  }

  void dispose() {
    _stateController.close();
  }
}
