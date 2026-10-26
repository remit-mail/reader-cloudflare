resource "cloudflare_zero_trust_access_service_token" "agent" {
  account_id = var.account_id
  name       = "${local.name}-agent"
  duration   = "8760h"
}

resource "cloudflare_zero_trust_access_policy" "agent" {
  account_id = var.account_id
  name       = "${local.name}-agent"
  decision   = "non_identity"
  include = [{
    service_token = {
      token_id = cloudflare_zero_trust_access_service_token.agent.id
    }
  }]
}
