terraform {
  required_version = ">= 1.10"

  required_providers {
    cloudflare = {
      source  = "cloudflare/cloudflare"
      version = "~> 5.26"
    }
    random = {
      source  = "hashicorp/random"
      version = "~> 3.7"
    }
  }

  backend "local" {}
}

provider "cloudflare" {}

locals {
  name = "reader-cloudflare"
}

resource "cloudflare_d1_database" "app" {
  account_id            = var.account_id
  name                  = local.name
  primary_location_hint = "weur"

  lifecycle {
    prevent_destroy = true
  }
}

resource "cloudflare_r2_bucket" "mail" {
  account_id = var.account_id
  name       = "${local.name}-mail"
  location   = "weur"

  lifecycle {
    prevent_destroy = true
  }
}

resource "cloudflare_queue" "sync" {
  account_id = var.account_id
  queue_name = "${local.name}-sync"
}

resource "cloudflare_secrets_store" "this" {
  account_id = var.account_id
  name       = local.name
}

resource "random_bytes" "master_key" {
  length = 32
}

resource "cloudflare_secrets_store_secret" "master_key" {
  account_id = var.account_id
  store_id   = cloudflare_secrets_store.this.id
  name       = "MASTER_KEY"
  value      = random_bytes.master_key.base64
  scopes     = ["workers"]
  comment    = "Master encryption key for reader-cloudflare"

  lifecycle {
    prevent_destroy = true
  }
}

resource "cloudflare_worker" "reader" {
  account_id = var.account_id
  name       = local.name

  observability = {
    enabled = true
  }

  subdomain = {
    enabled = false
  }
}

data "cloudflare_zero_trust_access_identity_providers" "all" {
  account_id = var.account_id
}

locals {
  otp_idp_id = one([
    for idp in data.cloudflare_zero_trust_access_identity_providers.all.result : idp.id
    if idp.type == "onetimepin"
  ])
}

resource "cloudflare_zero_trust_access_policy" "owner" {
  account_id = var.account_id
  name       = "${local.name}-owner"
  decision   = "allow"
  include = [for email in var.allowed_emails : {
    email = {
      email = email
    }
  }]
}

resource "cloudflare_zero_trust_access_application" "reader" {
  account_id = var.account_id
  name       = local.name
  type       = "self_hosted"
  domain     = var.app_domain
  destinations = [{
    type = "public"
    uri  = var.app_domain
  }]
  session_duration          = "720h"
  auto_redirect_to_identity = true
  enable_binding_cookie     = false
  options_preflight_bypass  = false
  allowed_idps              = [local.otp_idp_id]
  policies = [{
    id         = cloudflare_zero_trust_access_policy.owner.id
    precedence = 1
  }]
}
