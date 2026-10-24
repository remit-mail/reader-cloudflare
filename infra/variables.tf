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
