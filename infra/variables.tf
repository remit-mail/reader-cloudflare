variable "account_id" {
  type        = string
  description = "Cloudflare account that owns the Worker and its storage; set from CLOUDFLARE_ACCOUNT_ID by npm-scripts/infra.mjs."
}

variable "app_domain" {
  type        = string
  description = "Custom domain of the reader-cloudflare Worker (routes in wrangler.jsonc), guarded by Access."
  default     = "app.remit.email"
}

variable "allowed_emails" {
  type        = list(string)
  description = "Addresses Access lets through with a one-time PIN."
  default     = ["matthijs@ischen.nl"]
}

variable "alert_email" {
  type        = string
  description = "Address that receives every notification policy in notifications.tf."
  default     = "matthijs@ischen.nl"
}

variable "usage_alert_limits" {
  type        = map(number)
  description = "billing_usage_alert threshold per Cloudflare product id, per billing period. Defaults sit at the Workers Paid included quota."
  default = {
    worker_requests                        = 10000000
    worker_standard_cpu_ms                 = 30000000
    worker_durable_objects_requests        = 1000000
    worker_durable_objects_duration        = 400000
    worker_durable_objects_stored_data     = 1000000000
    worker_durable_objects_storage_reads   = 1000000
    worker_durable_objects_storage_writes  = 1000000
    worker_durable_objects_storage_deletes = 1000000
    d1_rows_read                           = 25000000000
    d1_rows_written                        = 50000000
    d1_storage                             = 5000000000
    r2_storage                             = 10000000000
    r2_class_a_operations                  = 1000000
    r2_class_b_operations                  = 10000000
    queues_standard_operations             = 1000000
  }
}
