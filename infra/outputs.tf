output "worker_name" {
  description = "name in the rendered wrangler.deploy.jsonc."
  value       = cloudflare_worker.reader.name
}

output "app_hostname" {
  description = "Custom domain route and PUBLIC_ORIGIN host in the rendered wrangler.deploy.jsonc."
  value       = cloudflare_zero_trust_access_application.reader.domain
}

output "d1_database_name" {
  description = "database_name of the DB binding in the rendered wrangler.deploy.jsonc."
  value       = cloudflare_d1_database.app.name
}

output "d1_database_id" {
  description = "database_id of the DB binding in the rendered wrangler.deploy.jsonc."
  value       = cloudflare_d1_database.app.uuid
}

output "r2_bucket_name" {
  description = "bucket_name of the MAIL binding in the rendered wrangler.deploy.jsonc."
  value       = cloudflare_r2_bucket.mail.name
}

output "queues" {
  description = "Queue name per family, for every producer and consumer in the rendered wrangler.deploy.jsonc."
  value = {
    sync     = cloudflare_queue.sync.queue_name
    body     = cloudflare_queue.body.queue_name
    mutation = cloudflare_queue.mutation.queue_name
    smtp     = cloudflare_queue.smtp.queue_name
    fanout   = cloudflare_queue.fanout.queue_name
    dlq      = cloudflare_queue.dlq.queue_name
  }
}

output "secrets_store_id" {
  description = "store_id of the MASTER_KEY binding in the rendered wrangler.deploy.jsonc."
  value       = local.secrets_store_id
}

output "master_key_secret_name" {
  description = "secret_name of the MASTER_KEY binding in the rendered wrangler.deploy.jsonc; the stages share the account's one Secrets Store, made by tofu-bootstrap."
  value       = cloudflare_secrets_store_secret.master_key.name
}

output "worker_id" {
  description = "Worker tag that Workers Builds connects to."
  value       = cloudflare_worker.reader.id
}

output "access_aud" {
  description = "Application audience tag, ACCESS_AUD in the rendered wrangler.deploy.jsonc."
  value       = cloudflare_zero_trust_access_application.reader.aud
}

output "access_team_domain" {
  description = "Access team domain, ACCESS_TEAM_DOMAIN in the rendered wrangler.deploy.jsonc."
  value       = cloudflare_zero_trust_organization.this.auth_domain
}

output "debug_token" {
  description = "Read-biased token for agents, minted by the prod stage only; npm run cf-env:write puts it in cf-env."
  value       = local.prod ? cloudflare_account_token.debug[0].value : null
  sensitive   = true
}

output "agent_client_id" {
  description = "CF-Access-Client-Id of the agent service token; npm run access-env:write puts it in access-env."
  value       = cloudflare_zero_trust_access_service_token.agent.client_id
  sensitive   = true
}

output "agent_client_secret" {
  description = "CF-Access-Client-Secret of the agent service token; npm run access-env:write puts it in access-env."
  value       = cloudflare_zero_trust_access_service_token.agent.client_secret
  sensitive   = true
}

output "microsoft_oauth" {
  description = "MSOAUTH_CLIENT_ID and the MSOAUTH_CLIENT_SECRET binding in the rendered wrangler.deploy.jsonc; null when the deploy config sets no Microsoft app."
  value = local.microsoft_oauth ? {
    client_id   = nonsensitive(var.msoauth.client_id)
    secret_name = cloudflare_secrets_store_secret.msoauth_client_secret[0].name
  } : null
}

output "login_worker_name" {
  description = "name in the rendered packages/login/wrangler.deploy.jsonc."
  value       = cloudflare_worker.login.name
}

output "login_hostname" {
  description = "Custom domain route and LOGIN_ORIGIN host in the rendered packages/login/wrangler.deploy.jsonc."
  value       = var.login_hostname
}

output "login_d1_database_name" {
  description = "database_name of the login DB binding."
  value       = cloudflare_d1_database.login.name
}

output "login_d1_database_id" {
  description = "database_id of the login DB binding."
  value       = cloudflare_d1_database.login.uuid
}

output "login_oidc_client_id" {
  description = "LOGIN_OIDC_CLIENT_ID and the client_id of the Access identity provider."
  value       = local.login_oidc_client_id
}

output "login_oidc_client_secret_hash" {
  description = "SHA-256 base64url of the OIDC client secret, the client_secret deploy writes to the login oauth_client row."
  value       = replace(replace(trimsuffix(base64sha256(local.login_oidc_secret_value), "="), "+", "-"), "/", "_")
  sensitive   = true
}

output "email_sender" {
  description = "EMAIL_SENDER and the allowed sender of the EMAIL binding."
  value       = var.email_sender
}
