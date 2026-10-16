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
      return ApiResponse(statusCode: e.response?.statusCode ?? 500, data: e.response?.data ?? {'success': false, 'error': e.message});
    } catch (e) {
      return ApiResponse(statusCode: 500, data: {'success': false, 'error': e.toString()});
    }
  }
