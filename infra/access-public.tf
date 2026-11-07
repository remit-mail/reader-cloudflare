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
  store_id   = local.secrets_store_id
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
  allowed_idps = [cloudflare_zero_trust_access_identity_provider.login.id]
  policies = [{
    id         = cloudflare_zero_trust_access_policy.public.id
    precedence = 1
  }]

  lifecycle {
    precondition {
      condition     = alltrue([for path in local.public_paths : split("/", path)[0] != var.login_hostname])
      error_message = "Access application ${local.name}-public must not cover the login hostname."
    }
  }
}
