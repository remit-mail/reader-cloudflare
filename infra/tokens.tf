data "cloudflare_account_api_token_permission_groups_list" "account" {
  account_id = var.account_id
  scope      = "com.cloudflare.api.account"
}

data "cloudflare_account_api_token_permission_groups_list" "zone" {
  account_id = var.account_id
  scope      = "com.cloudflare.api.account.zone"
}

locals {
  account_permission_ids = {
    for group in data.cloudflare_account_api_token_permission_groups_list.account.result : group.name => group.id
  }

  zone_permission_ids = {
    for group in data.cloudflare_account_api_token_permission_groups_list.zone.result : group.name => group.id
  }

  account_resources = jsonencode({ "com.cloudflare.api.account.${var.account_id}" = "*" })

  account_zone_resources = jsonencode({ "com.cloudflare.api.account.${var.account_id}" = { "com.cloudflare.api.account.zone.*" = "*" } })

  debug_zone_permissions = [
    "Analytics Read",
    "Firewall Services Write",
    "Zone WAF Write",
    "Zone Settings Write",
  ]

  debug_account_permissions = [
    "Account Settings Read",
    "Workers Scripts Read",
    "Workers Tail Read",
    "Workers Observability Write",
    "Workers CI Read",
    "D1 Read",
    "Queues Read",
  ]
}

resource "cloudflare_account_token" "debug" {
  account_id = var.account_id
  name       = "${local.name}-debug"

  policies = [
    {
      effect            = "allow"
      resources         = local.account_resources
      permission_groups = [for name in local.debug_account_permissions : { id = local.account_permission_ids[name] }]
    },
    {
      effect            = "allow"
      resources         = local.account_zone_resources
      permission_groups = [for name in local.debug_zone_permissions : { id = local.zone_permission_ids[name] }]
    },
  ]

  lifecycle {
    create_before_destroy = true
  }
}
