# DataSource Editor Guide

The DataSource editor is an optional panel that talks to the backend’s `/config` endpoint. When the backend exposes a configuration schema and model for its data sources, erdblick can fetch that schema and push edits back without leaving the browser. Use it for exploratory sessions or when you need to adjust a configuration on a running server.

_[Screenshot placeholder: DataSource editor panel showing a SmartLayerTileService entry.]_

## Prerequisites and Permissions

Before the editor can accept changes, the backend has to expose a configuration endpoint and make clear whether its contents are writable:

- Your backend must expose a `/config` endpoint that returns configuration data and, optionally, a JSON schema. If the endpoint is missing or returns an error, the editor will show a read‑only error message.
- To allow changes to be persisted, the backend must accept `POST` requests on `/config` and be configured with a writable configuration store (for example a non–read‑only config file or volume).
- The backend can indicate that editing is disabled by marking the configuration as read‑only. In that case erdblick still displays the configuration, but the **Apply** button is hidden. 

<!-- Note: the link below only works when the erdblick and mapget are bundled via the mapviewer project. -->

This behaviour is controlled through the `mapget` section in the `mapviewer.yaml` configuration file.
See the [Advanced mapget Configuration](../../docs/mv-config.md#advanced-mapget-configuration) chapter for details: Use `allow-post-config` to enable editing the config and `no-get-config` to disable viewing it.

## Editing Sources

Once the editor is available, you can adjust data sources directly from within erdblick instead of editing files by hand:

1. Open the quick menu (stacks icon) and click **Datasources**.
2. Erdblick loads the current configuration from the `/config` endpoint and shows it in the editor panel.
3. Update fields such as data source `type`, `uri`, `mapId`, coverage settings, or HTTP scopes according to your backend’s schema.
4. Click **Apply** to send the edited configuration back to the backend and refresh the list of maps and layers.

_[Screenshot placeholder: Validation error highlighting a missing HTTP scope.]_

## File-Based vs. UI Edits

The editor complements, rather than replaces, file-based configuration and fits best into an existing configuration management approach:

- UI edits send the updated configuration to the `/config` endpoint. How that data is stored (for example in a file or database) is entirely controlled by the backend.
- Keep the backend configuration in version control when possible. The editor is ideal for trying changes quickly; storing the final config alongside your project keeps environments reproducible.
- For locked‑down or air‑gapped setups, expose `/config` in read‑only mode or not at all so accidental writes are prevented.

## Auto-Restart Considerations

Changing live configuration can have side effects on the running backend, especially if it performs automatic reloads:

- After you apply a change, the backend will reload its data sources according to its own rules. Erdblick then refreshes the available maps and layers and re-requests tiles as needed.
- Frequent edits can cause extra load on the backend. Batch related changes and apply them together, especially in shared or production environments.

## Limitations

The DataSource editor deliberately focuses on a narrow slice of configuration so that it remains predictable and safe to use:

- Only data source definitions exposed by the backend appear in the form. Styles and other runtime settings are not part of this editor.
- Validation covers schema correctness but cannot verify that the referenced service actually exists. Keep the `Maps & Layers` panel open to verify connectivity after each change.
