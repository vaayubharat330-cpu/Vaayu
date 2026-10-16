import 'dart:convert';
import 'dart:io';
import '../projection/local_trip_projection.dart';
import 'pending_mutation.dart';

/// Abstract persistence contract for durable trip projections and offline mutations.
abstract class ILocalPersistenceService {
  Future<void> saveTripSnapshot(LocalTripProjection projection);
  Future<LocalTripProjection?> getTripSnapshot(String tripId);
  Future<void> clearTripSnapshot(String tripId);
  Future<void> enqueueMutation(PendingMutation mutation);
  Future<List<PendingMutation>> getPendingMutations();
  Future<void> removeMutation(String intentId);
  Future<void> savePendingMutation(PendingMutation mutation);
  Future<void> removePendingMutation(String intentId);
  Future<void> clearAllMutations();
}

class InMemoryLocalPersistenceService implements ILocalPersistenceService {
  final Map<String, String> _tripSnapshots = {};
  final Map<String, String> _mutationQueue = {};

  @override
  Future<void> saveTripSnapshot(LocalTripProjection projection) async {
    _tripSnapshots[projection.tripId] = jsonEncode(projection.toJson());
  }

  @override
  Future<LocalTripProjection?> getTripSnapshot(String tripId) async {
    final raw = _tripSnapshots[tripId];
    if (raw == null) return null;
    try {
      return LocalTripProjection.fromJson(jsonDecode(raw) as Map<String, dynamic>);
    } catch (_) {
      return null;
    }
  }

  @override
  Future<void> clearTripSnapshot(String tripId) async => _tripSnapshots.remove(tripId);

  @override
  Future<void> enqueueMutation(PendingMutation mutation) async {
    _mutationQueue[mutation.intentId] = jsonEncode(mutation.toJson());
  }

  @override
  Future<List<PendingMutation>> getPendingMutations() async {
    final results = <PendingMutation>[];
    for (final raw in _mutationQueue.values) {
      try {
        results.add(PendingMutation.fromJson(jsonDecode(raw) as Map<String, dynamic>));
      } catch (_) {}
    }
    results.sort((a, b) => a.createdAt.compareTo(b.createdAt));
    return results;
  }

  @override
  Future<void> removeMutation(String intentId) async => _mutationQueue.remove(intentId);

  @override
  Future<void> savePendingMutation(PendingMutation mutation) => enqueueMutation(mutation);

  @override
  Future<void> removePendingMutation(String intentId) => removeMutation(intentId);

  @override
  Future<void> clearAllMutations() async => _mutationQueue.clear();
}

/// Durable file-backed persistence for process termination and offline survival.
/// Writes use a temporary sibling file followed by rename so a crash cannot leave
/// the primary JSON file half-written.
class FileLocalPersistenceService implements ILocalPersistenceService {
  final Directory directory;
  final File _snapshotsFile;
  final File _mutationsFile;

  FileLocalPersistenceService({required this.directory})
      : _snapshotsFile = File('${directory.path}/vaayu_trip_snapshots.json'),
        _mutationsFile = File('${directory.path}/vaayu_pending_mutations.json') {
    if (!directory.existsSync()) directory.createSync(recursive: true);
  }

  factory FileLocalPersistenceService.fromPath(String path) {
    return FileLocalPersistenceService(directory: Directory(path));
  }

  Map<String, dynamic> _readJsonObject(File file) {
    if (!file.existsSync()) return <String, dynamic>{};
    try {
      final content = file.readAsStringSync();
      if (content.trim().isEmpty) return <String, dynamic>{};
      final decoded = jsonDecode(content);
      return decoded is Map ? Map<String, dynamic>.from(decoded) : <String, dynamic>{};
    } catch (_) {
      return <String, dynamic>{};
    }
  }

  void _atomicWriteJson(File target, Map<String, dynamic> map) {
    final temp = File('${target.path}.tmp-${DateTime.now().microsecondsSinceEpoch}');
    try {
      temp.writeAsStringSync(jsonEncode(map), flush: true);
      temp.renameSync(target.path);
    } finally {
      if (temp.existsSync()) {
        try {
          temp.deleteSync();
        } catch (_) {}
      }
    }
  }

  @override
  Future<void> saveTripSnapshot(LocalTripProjection projection) async {
    final map = _readJsonObject(_snapshotsFile);
    map[projection.tripId] = projection.toJson();
    _atomicWriteJson(_snapshotsFile, map);
  }

  @override
  Future<LocalTripProjection?> getTripSnapshot(String tripId) async {
    final raw = _readJsonObject(_snapshotsFile)[tripId];
    if (raw is! Map) return null;
    try {
      return LocalTripProjection.fromJson(Map<String, dynamic>.from(raw));
    } catch (_) {
      return null;
    }
  }

  @override
  Future<void> clearTripSnapshot(String tripId) async {
    final map = _readJsonObject(_snapshotsFile);
    if (!map.containsKey(tripId)) return;
    map.remove(tripId);
    _atomicWriteJson(_snapshotsFile, map);
  }

  @override
  Future<void> enqueueMutation(PendingMutation mutation) async {
    final map = _readJsonObject(_mutationsFile);
    map[mutation.intentId] = mutation.toJson();
    _atomicWriteJson(_mutationsFile, map);
  }

  @override
  Future<List<PendingMutation>> getPendingMutations() async {
    final map = _readJsonObject(_mutationsFile);
    final results = <PendingMutation>[];
    for (final raw in map.values) {
      if (raw is! Map) continue;
      try {
        results.add(PendingMutation.fromJson(Map<String, dynamic>.from(raw)));
      } catch (_) {}
    }
    results.sort((a, b) => a.createdAt.compareTo(b.createdAt));
    return results;
  }

  @override
  Future<void> removeMutation(String intentId) async {
    final map = _readJsonObject(_mutationsFile);
    if (!map.containsKey(intentId)) return;
    map.remove(intentId);
    _atomicWriteJson(_mutationsFile, map);
  }

  @override
  Future<void> savePendingMutation(PendingMutation mutation) => enqueueMutation(mutation);

  @override
  Future<void> removePendingMutation(String intentId) => removeMutation(intentId);

  @override
  Future<void> clearAllMutations() async => _atomicWriteJson(_mutationsFile, <String, dynamic>{});
}

typedef LocalPersistenceService = ILocalPersistenceService;
