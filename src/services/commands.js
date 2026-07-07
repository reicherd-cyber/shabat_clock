import { ApiError, notFound } from '../config/errors.js';

export function assertRelayCommandable(relay, actingUserId) {
  if (!relay || Number(relay.user_id) !== Number(actingUserId) || relay.deleted_at || !relay.is_enabled) {
    throw notFound('RELAY_NOT_FOUND', 'Relay not found');
  }
}

export function assertScheduleCommandInvariant(command, execution) {
  if (command.source !== 'schedule') return;
  if (!command.schedule_execution_id) {
    throw new ApiError(500, 'INTERNAL', 'source=schedule command requires schedule_execution_id');
  }
  if (
    Number(command.schedule_execution_id) !== Number(execution.id) ||
    Number(command.schedule_id) !== Number(execution.schedule_id) ||
    command.action !== execution.action
  ) {
    throw new ApiError(500, 'INTERNAL', 'Schedule command does not match execution row');
  }
}
