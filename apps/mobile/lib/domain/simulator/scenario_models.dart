/// Domain models for the VAAYU Multi-Role Scenario Harness.
/// Captures deterministic simulation steps, observable outcomes across
/// Customer, Driver, and Operations surfaces, and double-entry ledger audits.
library scenario_models;

enum SimulationSurface {
  customer,
  driver,
  operations,
  backend,
}

class ScenarioStepResult {
  final int stepIndex;
  final String title;
  final SimulationSurface surface;
  final bool success;
  final int durationMs;
  final String details;
  final String? orderId;
  final int? version;
  final double? ledgerImbalance;

  const ScenarioStepResult({
    required this.stepIndex,
    required this.title,
    required this.surface,
    required this.success,
    required this.durationMs,
    required this.details,
    this.orderId,
    this.version,
    this.ledgerImbalance,
  });
}

class ScenarioRunReport {
  final String scenarioId;
  final String title;
  final bool success;
  final int totalDurationMs;
  final List<ScenarioStepResult> steps;
  final String summary;

  const ScenarioRunReport({
    required this.scenarioId,
    required this.title,
    required this.success,
    required this.totalDurationMs,
    required this.steps,
    required this.summary,
  });
}

class ScenarioDefinition {
  final String id;
  final String title;
  final String description;
  final String expectedOutcome;

  const ScenarioDefinition({
    required this.id,
    required this.title,
    required this.description,
    required this.expectedOutcome,
  });
}
