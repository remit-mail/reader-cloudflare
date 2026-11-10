locals {
  classification_default = nonsensitive(var.classification != null)
}

resource "cloudflare_secrets_store_secret" "classification_default_api_key" {
  count      = local.classification_default ? 1 : 0
  account_id = var.account_id
  store_id   = local.secrets_store_id
  name       = "CLASSIFICATION_DEFAULT_API_KEY"
  value      = var.classification.api_key
  scopes     = ["workers"]
  comment    = "Deployment default mail classifier API key for ${local.name}"
}
