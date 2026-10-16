import 'package:dio/dio.dart';
import '../session/auth_contracts.dart';
import 'idempotency_manager.dart';
import 'single_flight_refresh.dart';

class ApiRequestOptions {
  final String path;
  final String method;
  final dynamic data;
  final Map<String, dynamic>? queryParameters;
  final Map<String, String>? headers;
  final bool requiresAuth;
  final String? intentId;

  const ApiRequestOptions({required this.path, required this.method, this.data, this.queryParameters, this.headers, this.requiresAuth = true, this.intentId});
  bool get isMutation => method == 'POST' || method == 'PUT' || method == 'PATCH' || method == 'DELETE';
}

class ApiResponse<T> {
  final int statusCode;
  final T data;
  final Map<String, dynamic> headers;
  const ApiResponse({required this.statusCode, required this.data, this.headers = const {}});
  bool get isSuccess => statusCode >= 200 && statusCode < 300;
}

abstract class IApiClient { Future<ApiResponse<T>> request<T>(ApiRequestOptions options); }

class NetworkInterceptorPipeline {
  final ITokenProvider _tokenProvider;
  final IIdempotencyManager _idempotencyManager;
  NetworkInterceptorPipeline({required ITokenProvider tokenProvider, required IIdempotencyManager idempotencyManager}) : _tokenProvider = tokenProvider, _idempotencyManager = idempotencyManager;

  Future<Map<String, String>> prepareHeaders(ApiRequestOptions options) async {
    final headers = Map<String, String>.from(options.headers ?? {});
    if (options.requiresAuth) headers['Authorization'] = 'Bearer ${await _tokenProvider.getValidToken()}';
    if (options.isMutation && options.intentId != null) headers['X-Idempotency-Key'] = _idempotencyManager.getOrCreateKey(intentId: options.intentId!);
    headers['Content-Type'] = 'application/json';
    headers['Accept'] = 'application/json';
    return headers;
  }
}

class ApiClient {
  final String baseUrl;
  final ITokenProvider tokenProvider;
  final IIdempotencyManager idempotencyManager;
  final SingleFlightRefreshCoordinator? refreshCoordinator;
  final Dio _dio;

  ApiClient({required this.baseUrl, required this.tokenProvider, required this.idempotencyManager, this.refreshCoordinator, Dio? dio}) : _dio = dio ?? Dio(BaseOptions(baseUrl: baseUrl, connectTimeout: const Duration(seconds: 10), receiveTimeout: const Duration(seconds: 10), headers: const {'Accept': 'application/json', 'Content-Type': 'application/json'}));

  Future<ApiResponse<dynamic>> _executeWithAuthRetry(Future<Response<dynamic>> Function(Map<String, String> headers) makeCall, {Map<String, String>? initialHeaders}) async {
    final headers = Map<String, String>.from(initialHeaders ?? {});
    try {
      final token = await tokenProvider.getValidToken();
      if (token.isNotEmpty) headers['Authorization'] = 'Bearer $token';
    } catch (_) {}
    try {
      final response = await makeCall(headers);
      if (response.statusCode == 401 && refreshCoordinator != null) return await _handle401Retry(makeCall, headers);
      return ApiResponse(statusCode: response.statusCode ?? 200, data: response.data);
    } on DioException catch (e) {
      if (e.response?.statusCode == 401 && refreshCoordinator != null) return await _handle401Retry(makeCall, headers);
      return ApiResponse(statusCode: e.response?.statusCode ?? 500, data: e.response?.data ?? {'success': false, 'error': e.message});
    } catch (e) {
      return ApiResponse(statusCode: 500, data: {'success': false, 'error': e.toString()});
    }
  }

  Future<ApiResponse<dynamic>> _handle401Retry(Future<Response<dynamic>> Function(Map<String, String> headers) makeCall, Map<String, String> headers) async {
    try {
      final newToken = await refreshCoordinator!.refreshToken();
      headers['Authorization'] = 'Bearer $newToken';
      final retried = await makeCall(headers);
      return ApiResponse(statusCode: retried.statusCode ?? 200, data: retried.data);
    } on DioException catch (e) {
      return ApiResponse(statusCode: e.response?.statusCode ?? 401, data: e.response?.data ?? {'success': false, 'error': e.message});
    } catch (e) {
      return ApiResponse(statusCode: 401, data: {'success': false, 'error': e.toString()});
    }
  }

  Future<ApiResponse<dynamic>> get(String path, {Map<String, dynamic>? queryParameters}) => _executeWithAuthRetry((headers) => _dio.get(path, queryParameters: queryParameters, options: Options(headers: headers)));

  Future<ApiResponse< List<int> >> getBytes(String path, {Map<String, dynamic>? queryParameters}) async {
    final result = await _executeWithAuthRetry((headers) => _dio.get<List<int>>(path, queryParameters: queryParameters, options: Options(headers: headers, responseType: ResponseType.bytes)));
    final data = result.data;
    return ApiResponse<List<int>>(statusCode: result.statusCode, data: data is List<int> ? data : <int>[]);
  }

  Future<ApiResponse<dynamic>> post(String path, {dynamic body, String? idempotencyKey}) {
    final initialHeaders = <String, String>{};
    if (idempotencyKey != null && idempotencyKey.isNotEmpty) initialHeaders['X-Idempotency-Key'] = idempotencyKey;
    return _executeWithAuthRetry((headers) => _dio.post(path, data: body, options: Options(headers: headers)), initialHeaders: initialHeaders);
  }
}