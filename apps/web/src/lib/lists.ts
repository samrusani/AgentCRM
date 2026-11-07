import { AddMembersError } from '../api/client';
import type { AddMembersResult } from '../api/types';
import { errorMessage } from '../components/common';

const people = (count: number) => `${count} ${count === 1 ? 'person' : 'people'}`;

// The toast after adding selected people to a list: how many were added and how many were already members.
export function addedMessage(result: AddMembersResult, listName: string): string {
  if (result.added === 0) {
    return result.already === 1
      ? `That person was already on ${listName}.`
      : `All ${result.already} people were already on ${listName}.`;
  }
  const added = `Added ${people(result.added)} to ${listName}.`;
  if (result.already === 0) return added;
  return `${added} ${result.already === 1 ? '1 was' : `${result.already} were`} already on it.`;
}

export function removedMessage(removed: number, selected: number, listName: string): string {
  if (removed === selected) return `Removed ${people(removed)} from ${listName}.`;
  const failed = selected - removed;
  return `Removed ${removed} of ${people(selected)} from ${listName}. ${failed} could not be removed and stay selected. Try again.`;
}

// A failure sentence that always ends with what to do next, whatever punctuation the server's message carries.
export function withNextStep(error: unknown, next: string): string {
  const reason = errorMessage(error).trim();
  return `${/[.!?]$/.test(reason) ? reason : `${reason}.`} ${next}`;
}

// For a chunked add that failed partway: how many went in before the failure, or an empty string when nobody did.
export function addedBeforeFailure(error: unknown): string {
  if (!(error instanceof AddMembersError) || error.added === 0) return '';
  return `${error.added} added before the failure.`;
}
