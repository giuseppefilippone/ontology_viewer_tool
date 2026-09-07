// Built-in view "Entities" — registration only: its implementation (sidebar, trees, entity
// pages, edit dialogs) is the entities.js KIT, shared with every other view (openEntity, show…).
// Deleting this folder removes the tab; the kit stays for the views that link into entities.

registerView({
	id: 'entities',
	title: 'Entities',
	tooltip: 'Browse and edit the classes, individuals, properties and datatypes of the workspace',
	render: () => fitSidebar(),
});
