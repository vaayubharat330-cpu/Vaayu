/// App Navigation Router & Route Definitions.
/// Enforces role-based route guards based on active AuthSession.
library app_router;

import '../../core/models/auth_session.dart';

enum AppRoute {
  splash,
  login,
  customerHome,
  customerBooking,
  customerTracking,
  driverDashboard,
  driverActiveTrip,
  operationsDashboard,
  unauthorized
}

class AppRouter {
  AuthSession? _currentSession;
  AppRoute _currentRoute = AppRoute.splash;

  AppRouter({AuthSession? initialSession}) : _currentSession = initialSession {
    _evaluateInitialRoute();
  }

  AppRoute get currentRoute => _currentRoute;
  AuthSession? get currentSession => _currentSession;

  static const List<String> opsRoles = [
    'ADMIN',
    'SUPER_ADMIN',
    'FLEET_ADMIN',
    'DISPATCH_OPERATOR',
    'SUPPORT_AGENT',
  ];

  void updateSession(AuthSession? session) {
    _currentSession = session;
    _evaluateRouteGuard();
  }

  void _evaluateInitialRoute() {
    if (_currentSession == null || _currentSession!.isExpired) {
      _currentRoute = AppRoute.login;
    } else if (_currentSession!.role == 'CUSTOMER') {
      _currentRoute = AppRoute.customerHome;
    } else if (_currentSession!.role == 'DRIVER') {
      _currentRoute = AppRoute.driverDashboard;
    } else if (opsRoles.contains(_currentSession!.role)) {
      _currentRoute = AppRoute.operationsDashboard;
    } else {
      _currentRoute = AppRoute.unauthorized;
    }
  }

  void _evaluateRouteGuard() {
    if (_currentSession == null || _currentSession!.isExpired) {
      _currentRoute = AppRoute.login;
      return;
    }

    // Role Guarding
    if (_currentSession!.role == 'CUSTOMER') {
      if (_currentRoute == AppRoute.login ||
          _currentRoute == AppRoute.driverDashboard ||
          _currentRoute == AppRoute.driverActiveTrip ||
          _currentRoute == AppRoute.operationsDashboard) {
        _currentRoute = AppRoute.customerHome;
      }
    } else if (_currentSession!.role == 'DRIVER') {
      if (_currentRoute == AppRoute.login ||
          _currentRoute == AppRoute.customerHome ||
          _currentRoute == AppRoute.customerBooking ||
          _currentRoute == AppRoute.customerTracking ||
          _currentRoute == AppRoute.operationsDashboard) {
        _currentRoute = AppRoute.driverDashboard;
      }
    } else if (opsRoles.contains(_currentSession!.role)) {
      if (_currentRoute == AppRoute.login ||
          _currentRoute == AppRoute.customerHome ||
          _currentRoute == AppRoute.customerBooking ||
          _currentRoute == AppRoute.customerTracking ||
          _currentRoute == AppRoute.driverDashboard ||
          _currentRoute == AppRoute.driverActiveTrip) {
        _currentRoute = AppRoute.operationsDashboard;
      }
    }
  }

  /// Navigates to target route respecting active role boundaries.
  bool navigateTo(AppRoute target) {
    if (target == AppRoute.login || target == AppRoute.splash) {
      _currentRoute = target;
      return true;
    }

    if (_currentSession == null || _currentSession!.isExpired) {
      _currentRoute = AppRoute.login;
      return false; // Guarded: not authenticated
    }

    // Customer route protection
    if ((target == AppRoute.customerHome || target == AppRoute.customerBooking || target == AppRoute.customerTracking) &&
        _currentSession!.role != 'CUSTOMER') {
      return false; // Guarded: wrong role
    }

    // Driver route protection
    if ((target == AppRoute.driverDashboard || target == AppRoute.driverActiveTrip) &&
        _currentSession!.role != 'DRIVER') {
      return false; // Guarded: wrong role
    }

    // Operations route protection
    if (target == AppRoute.operationsDashboard && !opsRoles.contains(_currentSession!.role)) {
      return false; // Guarded: wrong role
    }

    _currentRoute = target;
    return true;
  }
}
