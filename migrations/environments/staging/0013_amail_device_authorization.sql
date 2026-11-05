-- Enable the existing native client without changing pairwise subject mapping.
UPDATE oauth_clients
SET device_authorization_enabled = 1, updated_at = unixepoch()
WHERE client_id = 'amail-cli-staging';
