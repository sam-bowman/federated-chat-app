{{/*
Chart name, truncated/sanitized per Helm's own convention.
*/}}
{{- define "chat.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{/*
Fully-qualified release name.
*/}}
{{- define "chat.fullname" -}}
{{- if .Values.fullnameOverride -}}
{{- .Values.fullnameOverride | trunc 63 | trimSuffix "-" -}}
{{- else -}}
{{- $name := default .Chart.Name .Values.nameOverride -}}
{{- if contains $name .Release.Name -}}
{{- .Release.Name | trunc 63 | trimSuffix "-" -}}
{{- else -}}
{{- printf "%s-%s" .Release.Name $name | trunc 63 | trimSuffix "-" -}}
{{- end -}}
{{- end -}}
{{- end -}}

{{- define "chat.chart" -}}
{{- printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{- define "chat.labels" -}}
helm.sh/chart: {{ include "chat.chart" . }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{ include "chat.selectorLabels" . }}
{{- end -}}

{{- define "chat.selectorLabels" -}}
app.kubernetes.io/name: {{ include "chat.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end -}}

{{/*
Per-component (server/client/postgres/redis) names and labels - keeps
"<release>-federated-chat-app-server" style resource names without
repeating the concatenation everywhere.
*/}}
{{- define "chat.componentName" -}}
{{- printf "%s-%s" (include "chat.fullname" .ctx) .component -}}
{{- end -}}

{{- define "chat.componentLabels" -}}
{{ include "chat.labels" .ctx }}
app.kubernetes.io/component: {{ .component }}
{{- end -}}

{{- define "chat.componentSelectorLabels" -}}
{{ include "chat.selectorLabels" .ctx }}
app.kubernetes.io/component: {{ .component }}
{{- end -}}

{{/*
Fails the render with a clear message instead of deploying something
broken - same fail-fast philosophy as docker-compose.selfhost.yml's
${VAR:?message} required vars (server/src/config.ts would otherwise
silently fall back to a dev-insecure default).
*/}}
{{- define "chat.validate" -}}
{{- if and (not .Values.secrets.existingSecret) (or (not .Values.secrets.jwtAccessSecret) (not .Values.secrets.jwtRefreshSecret)) -}}
{{- fail "secrets.jwtAccessSecret and secrets.jwtRefreshSecret are required (generate each with: openssl rand -base64 32), or set secrets.existingSecret to a pre-existing Secret with keys jwt-access-secret/jwt-refresh-secret" -}}
{{- end -}}
{{- if not .Values.domain -}}
{{- fail "domain is required - this homeserver's own domain, becomes part of every user id (@user:domain)" -}}
{{- end -}}
{{- if not .Values.server.publicUrl -}}
{{- fail "server.publicUrl is required - this server's externally-reachable origin, e.g. https://api.chat.example.com" -}}
{{- end -}}
{{- if not .Values.server.clientPublicUrl -}}
{{- fail "server.clientPublicUrl is required - the client's externally-reachable origin, becomes CORS_ORIGIN" -}}
{{- end -}}
{{- if .Values.postgresql.enabled -}}
{{- if and (not .Values.postgresql.auth.existingSecret) (not .Values.postgresql.auth.password) -}}
{{- fail "postgresql.auth.password is required when postgresql.enabled is true (generate with: openssl rand -base64 24), or set postgresql.auth.existingSecret to a pre-existing Secret with key postgres-password" -}}
{{- end -}}
{{- else -}}
{{- if not .Values.externalDatabase.url -}}
{{- fail "externalDatabase.url is required when postgresql.enabled is false" -}}
{{- end -}}
{{- end -}}
{{- if and (gt (int .Values.server.replicaCount) 1) (not .Values.redis.enabled) (not .Values.externalRedisUrl) -}}
{{- fail "server.replicaCount > 1 needs redis.enabled: true (or externalRedisUrl set to an external Redis) - otherwise each replica tracks presence/rate-limits/realtime delivery independently, which silently breaks cross-replica behavior. See README \"Running multiple replicas\"." -}}
{{- end -}}
{{- if eq .Values.server.storage.driver "s3" -}}
{{- if not .Values.server.storage.s3.bucket -}}
{{- fail "server.storage.s3.bucket is required when server.storage.driver is \"s3\"" -}}
{{- end -}}
{{- if not .Values.server.storage.s3.region -}}
{{- fail "server.storage.s3.region is required when server.storage.driver is \"s3\"" -}}
{{- end -}}
{{- if not .Values.server.storage.s3.publicUrlBase -}}
{{- fail "server.storage.s3.publicUrlBase is required when server.storage.driver is \"s3\" - see server/.env.example's S3_PUBLIC_URL_BASE comment for why this can't be derived automatically" -}}
{{- end -}}
{{- if and (not .Values.server.storage.s3.existingSecret) (or (not .Values.server.storage.s3.accessKeyId) (not .Values.server.storage.s3.secretAccessKey)) -}}
{{- fail "server.storage.s3.accessKeyId and secretAccessKey are required when server.storage.driver is \"s3\" (or set server.storage.s3.existingSecret to a pre-existing Secret with keys access-key-id/secret-access-key)" -}}
{{- end -}}
{{- end -}}
{{- end -}}

{{/*
This server's database URL - the bundled Postgres (built from the
release's own Service name and the password Secret) or externalDatabase.url.
*/}}
{{- define "chat.databaseUrl" -}}
{{- if .Values.postgresql.enabled -}}
postgresql://{{ .Values.postgresql.auth.username }}:$(POSTGRES_PASSWORD)@{{ include "chat.componentName" (dict "ctx" . "component" "postgresql") }}:5432/{{ .Values.postgresql.auth.database }}
{{- else -}}
{{- .Values.externalDatabase.url -}}
{{- end -}}
{{- end -}}

{{/*
REDIS_URL for the bundled Redis, or externalRedisUrl, or empty (single
replica, no Redis).
*/}}
{{- define "chat.redisUrl" -}}
{{- if .Values.externalRedisUrl -}}
{{- .Values.externalRedisUrl -}}
{{- else if .Values.redis.enabled -}}
redis://{{ include "chat.componentName" (dict "ctx" . "component" "redis") }}:6379
{{- end -}}
{{- end -}}

{{/*
Resolves the image tag: an explicit per-component tag, else .Chart.AppVersion.
*/}}
{{- define "chat.imageTag" -}}
{{- default .Chart.AppVersion .tag -}}
{{- end -}}
