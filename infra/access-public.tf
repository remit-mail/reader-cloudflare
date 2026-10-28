locals {
  microsoft_oauth = nonsensitive(var.msoauth != null)
  public_paths = [
    "${var.app_hostname}/api/feeds/calendar/*",
    "${var.app_hostname}/api/accounts/oauth/microsoft/callback",
  ]
}

resource "cloudflare_secrets_store_secret" "msoauth_client_secret" {
  count      = local.microsoft_oauth ? 1 : 0
  account_id = var.account_id
  store_id   = cloudflare_secrets_store.this.id
  name       = "MSOAUTH_CLIENT_SECRET"
  value      = var.msoauth.client_secret
  scopes     = ["workers"]
  comment    = "Microsoft Entra client secret for ${local.name}"
}

resource "cloudflare_zero_trust_access_policy" "public" {
  account_id = var.account_id
  name       = "${local.name}-public"
  decision   = "bypass"
  include = [{
    everyone = {}
  }]
}

resource "cloudflare_zero_trust_access_application" "public" {
  account_id = var.account_id
  name       = "${local.name}-public"
  type       = "self_hosted"
  domain     = local.public_paths[0]
  destinations = [for path in local.public_paths : {
    type = "public"
    uri  = path
  }]
  policies = [{
    id         = cloudflare_zero_trust_access_policy.public.id
    precedence = 1
  }]
}
