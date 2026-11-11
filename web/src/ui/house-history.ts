// "Also delete this house's chats" in the remove-house dialog: with it, remove_project also deletes the house's chat
// transcripts and AI sessions, its run history and Undo checkpoints, and pictures nothing uses any more
// (server/projects.ts remove(…, { deleteHistory })). Off by default: removing a house keeps its chats, as before.
//
// Plugs into the remove-house dialog's option list (house-menu.ts `removeHouseOptions`):
//   removeHouseOptions.push(deleteHistoryOption);
import './css/trust.css';
import type { Project } from '../../../shared/protocol';
import { h } from './dom';

let box: HTMLInputElement | null = null;

export const deleteHistoryOption = {
  render(project: Project): HTMLElement {
    box = h('input', { type: 'checkbox' });
    return h(
      'label',
      { class: 'set-check house-history' },
      box,
      h(
        'span',
        null,
        h('strong', null, 'Also delete its chats and history'),
        h('span', { class: 'muted small set-block' }, `Every chat and AI session in ${project.name}, its run history and Undo points. The folder still stays.`),
      ),
    );
  },
  fields(): { deleteHistory?: true } {
    return box?.checked ? { deleteHistory: true } : {};
  },
};
