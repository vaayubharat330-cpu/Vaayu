import 'dart:convert';
import 'dart:io';
import '../projection/local_trip_projection.dart';
import 'pending_mutation.dart';

/// Abstract Persistence Storage Contract
/// Decouples persistence from SQFlite / Isar for deterministic testing.
abstract class ILocalPersistenceService {
  // Snapshot Management
  Future<void> saveTripSnapshot(LocalTripProjection projection);
  Future<LocalTripProjection?> getTripSnapshot(String tripId);
  Future<void> clearTripSnapshot(String tripId);

  // Pending Mutation Queue Management
  Future<void> enqueueMutation(PendingMutation mutation);
  Future<List<PendingMutation>> getPendingMutations();
  Future<void> removeMutation(String intentId);
  Future<void> savePendingMutation(PendingMutation mutation);
  Future<void> removePendingMutation(String intentId);
  Future<void> clearAllMutations();
}

/// In-Memory Implementation for Testing and Non-Platform Environments
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
      // Corrupt snapshot fails closed
      return null;
    }
  }

  @override
  Future<void> clearTripSnapshot(String tripId) async {
    _tripSnapshots.remove(tripId);
  }

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
    // Strict FIFO ordering by createdAt
    results.sort((a, b) => a.createdAt.compareTo(b.createdAt));
    return results;
  }

  @override
  Future<void> removeMutation(String intentId) async {
    _mutationQueue.remove(intentId);
  }

  @override
  Future<void> savePendingMutation(PendingMutation mutation) => enqueueMutation(mutation);
  @override
  Future<void> removePendingMutation(String intentId) => removeMutation(intentId);

  @override
  Future<void> clearAllMutations() async {
    _mutationQueue.clear();
  }
}

/// Durable File-Backed Persistence Service for Process Termination & Offline Survival
class FileLocalPersistenceService implements ILocalPersistenceService {
  final Directory directory;
  final File _snapshotsFile;
  final File _mutationsFile;

  FileLocalPersistenceService({required this.directory})
      : _snapshotsFile = File('${directory.path}/vaayu_trip_snapshots.json'),
        _mutationsFile = File('${directory.path}/vaayu_pending_mutations.json') {
    if (!directory.existsSync()) {
      directory.createSync(recursive: true);
    }
  }

  factory FileLocalPersistenceService.fromPath(String path) {
    return FileLocalPersistenceService(directory: Directory(path));
  }

  Map<String, dynamic> _readSnapshotsSync() {
    if (!_snapshotsFile.existsSync()) return <String, dynamic>{};
    try {
      final content = _snapshotsFile.readAsStringSync();
      if (content.trim().isEmpty) return <String, dynamic>{};
      return jsonDecode(content) as Map<String, dynamic>;
    } catch (_) {
      return <String, dynamic>{};
    }
  }

  void _writeSnapshotsSync(Map<String, dynamic> map) {
    _snapshotsFile.writeAsStringSync(jsonEncode(map), flush: true);
  }

  Map<String, dynamic> _readMutationsSync() {
    if (!_mutationsFile.existsSync()) return <String, dynamic>{};
    try {
      final content = _mutationsFile.readAsStringSync();
      if (content.trim().isEmpty) return <String, dynamic>{};
      return jsonDecode(content) as Map<String, dynamic>;
    } catch (_) {
      return <String, dynamic>{};
    }
  }

  void _writeMutationsSync(Map<String, dynamic> map) {
    _mutationsFile.writeAsStringSync(jsonEncode(map), flush: true);
  }

  @override
  Future<void> saveTripSnapshot(LocalTripProjection projection) async {
    final map = _readSnapshotsSync();
    map[projection.tripId] = projection.toJson();
    _writeSnapshotsSync(map);
  }

  @override
  Future<LocalTripProjection?> getTripSnapshot(String tripId) async {
    final map = _readSnapshotsSync();
    final raw = map[tripId];
    if (raw == null) return null;
    try {
      return LocalTripProjection.fromJson(raw as Map<String, dynamic>);
    } catch (_) {
      return null;
    }
  }

  @override
  Future<void> clearTripSnapshot(String tripId) async {
    final map = _readSnapshotsSync();
    if (map.containsKey(tripId)) {
      map.remove(tripId);
      _writeSnapshotsSync(map);
    }
  }

  @override
  Future<void> enqueueMutation(PendingMutation mutation) async {
    final map = _readMutationsSync();
    map[mutation.intentId] = mutation.toJson();
    _writeMutationsSync(map);
  }

  @override
  Future<List<PendingMutation>> getPendingMutations() async {
    final map = _readMutationsSync();
    final results = <PendingMutation>[];
    for (final raw in map.values) {
      try {
        results.add(PendingMutation.fromJson(raw as Map<String, dynamic>));
      } catch (_) {}
    }
    // Strict FIFO ordering by createdAt
    results.sort((a, b) => a.createdAt.compareTo(b.createdAt));
    return results;
  }

  @override
  Future<void> removeMutation(String intentId) async {
    final map = _readMutationsSync();
    if (map.containsKey(intentId)) {
      map.remove(intentId);
      _writeMutationsSync(map);
    }
  }

  @override
  Future<void> savePendingMutation(PendingMutation mutation) => enqueueMutation(mutation);

  @override
  Future<void> removePendingMutation(String intentId) => removeMutation(intentId);

  @override
  Future<void> clearAllMutations() async {
    _writeMutationsSync(<String, dynamic>{});
  }
}

typedef LocalPersistenceService = ILocalPersistenceService;
