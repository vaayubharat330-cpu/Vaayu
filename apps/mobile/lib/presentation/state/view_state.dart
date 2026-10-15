/// Base UI view state model for reactive presentation flows.
library view_state;

enum ViewStatus { initial, loading, success, failure }

class ViewState<T> {
  final ViewStatus status;
  final T? data;
  final String? errorMessage;

  const ViewState._({
    required this.status,
    this.data,
    this.errorMessage,
  });

  factory ViewState.initial([T? initialData]) => ViewState._(
        status: ViewStatus.initial,
        data: initialData,
      );

  factory ViewState.loading([T? previousData]) => ViewState._(
        status: ViewStatus.loading,
        data: previousData,
      );

  factory ViewState.success(T data) => ViewState._(
        status: ViewStatus.success,
        data: data,
      );

  factory ViewState.failure(String errorMessage, [T? previousData]) => ViewState._(
        status: ViewStatus.failure,
        data: previousData,
        errorMessage: errorMessage,
      );

  bool get isInitial => status == ViewStatus.initial;
  bool get isLoading => status == ViewStatus.loading;
  bool get isSuccess => status == ViewStatus.success;
  bool get isFailure => status == ViewStatus.failure;
}
