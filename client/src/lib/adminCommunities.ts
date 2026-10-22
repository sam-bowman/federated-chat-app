// What the admin page's Communities tab needs that is not a component.

/** Whether what was typed is the community's name: in any case, with the spaces off at both ends, as the server judges it (`confirm` of the delete). */
export const nameConfirmed = (typed: string, name: string): boolean => typed.trim().toLowerCase() === name.trim().toLowerCase();
