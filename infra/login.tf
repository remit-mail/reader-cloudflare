locals {
  login_origin            = "https://${var.login_hostname}"
  login_oidc_client_id    = "${local.name}-access"
  email_sender_domain     = split("@", var.email_sender)[1]
  login_idp_name          = "${local.name} login"
  other_stage_login_idp   = local.prod ? "${var.project}-dev login" : "${var.project} login"
  other_stage_login_idps  = [for idp in data.cloudflare_zero_trust_access_identity_providers.all.result : idp.id if idp.name == local.other_stage_login_idp]
  stage_idps              = [local.otp_idp_id, cloudflare_zero_trust_access_identity_provider.login.id]
  reader_allowed_idps     = concat([local.otp_idp_id], var.login_idp ? [cloudflare_zero_trust_access_identity_provider.login.id] : [])
  public_allowed_idps     = [local.otp_idp_id]
  login_oidc_secret_value = random_password.login_oidc_client_secret.result
  access_apps_on_login_host = [
    for app in data.cloudflare_zero_trust_access_applications.all.result : app.name
    if anytrue([
      for host in concat([coalesce(app.domain, "")], [for destination in coalesce(app.destinations, []) : coalesce(destination.uri, "")]) :
      split("/", host)[0] == var.login_hostname
    ])
  ]
}

resource "cloudflare_d1_database" "login" {
  account_id            = var.account_id
  name                  = "${local.name}-login"
  primary_location_hint = "weur"
  read_replication = {
    mode = "disabled"
  }

  lifecycle {
    prevent_destroy = true
  }
}

data "cloudflare_zero_trust_access_applications" "all" {
  account_id = var.account_id
}

resource "cloudflare_worker" "login" {
  account_id = var.account_id
  name       = "${local.name}-login"
  tags       = ["cf:service=${local.name}-login"]

  observability = {
    enabled = true
  }

  subdomain = {
    enabled = false
  }

  lifecycle {
    precondition {
      condition     = length(local.access_apps_on_login_host) == 0
      error_message = "The login hostname must have no Access application in front of it; these name it: ${join(", ", local.access_apps_on_login_host)}."
    }
  }
}

resource "random_password" "login_oidc_client_secret" {
  length  = 48
  special = false
}

resource "cloudflare_zero_trust_access_identity_provider" "login" {
  account_id = var.account_id
  name       = local.login_idp_name
  type       = "oidc"
  config = {
    client_id        = local.login_oidc_client_id
    client_secret    = local.login_oidc_secret_value
    auth_url         = "${local.login_origin}/api/auth/oauth2/authorize"
    token_url        = "${local.login_origin}/api/auth/oauth2/token"
    certs_url        = "${local.login_origin}/api/auth/jwks"
    scopes           = ["openid", "email", "profile"]
    pkce_enabled     = true
    email_claim_name = "email"
  }
}

resource "cloudflare_zero_trust_access_policy" "login" {
  account_id = var.account_id
  name       = "${local.name}-login"
  decision   = "allow"
  include = [{
    login_method = {
      id = cloudflare_zero_trust_access_identity_provider.login.id
    }
  }]
}

data "cloudflare_zone" "this" {
  filter = {
    name = var.zone_name
  }
}

resource "cloudflare_email_sending_subdomain" "login" {
  zone_id = data.cloudflare_zone.this.zone_id
  name    = local.email_sender_domain
}

import {
  for_each = var.login_idp ? toset([var.account_id]) : toset([])
  to       = cloudflare_zero_trust_organization.this[0]
  id       = "accounts/${each.value}"
}

resource "cloudflare_zero_trust_organization" "this" {
  count            = var.login_idp ? 1 : 0
  account_id       = var.account_id
  session_duration = "15m"

  lifecycle {
    prevent_destroy = true
    ignore_changes = [
      allow_authenticate_via_warp,
      auth_domain,
      auto_redirect_to_identity,
      custom_pages,
      deny_unmatched_requests,
      deny_unmatched_requests_exempted_zone_names,
      is_ui_read_only,
      login_design,
      mfa_config,
      mfa_configuration_allowed,
      mfa_piv_key_requirements,
      mfa_required_for_all_apps,
      name,
      service_token_inactivity,
      strict_service_token_auth,
      ui_read_only_toggle_reason,
      user_seat_expiration_inactive_time,
      warp_auth_non_browser_401,
      warp_auth_session_duration,
      zone_id,
    ]
  }
}

