output "d1_database_id" {
  description = "database_id of the DB binding in wrangler.jsonc."
  value       = cloudflare_d1_database.app.uuid
}

output "r2_bucket_name" {
  description = "bucket_name of the MAIL binding in wrangler.jsonc."
  value       = cloudflare_r2_bucket.mail.name
}

output "queue_name" {
  description = "Queue of the SYNC producer and consumer in wrangler.jsonc."
  value       = cloudflare_queue.sync.queue_name
}

output "secrets_store_id" {
  description = "store_id of the MASTER_KEY binding in wrangler.jsonc."
  value       = cloudflare_secrets_store.this.id
}

output "worker_id" {
  description = "Worker tag that Workers Builds connects to."
  value       = cloudflare_worker.reader.id
}

output "access_aud" {
  description = "Application audience tag for ACCESS_AUD."
  value       = cloudflare_zero_trust_access_application.reader.aud
}

output "debug_token" {
  description = "Read-biased token for agents; npm run cf-env:write puts it in cf-env."
  value       = cloudflare_account_token.debug.value
  sensitive   = true
}
