terraform {
  required_version = "1.13.2"

  required_providers {
    cloudflare = {
      source  = "cloudflare/cloudflare"
      version = "5.28.1"
    }
    random = {
      source  = "hashicorp/random"
      version = "3.9.1"
    }
  }

  backend "s3" {
    bucket                      = "reader-cloudflare-tfstate"
    key                         = "reader-cloudflare.tfstate"
    region                      = "auto"
    use_lockfile                = true
    use_path_style              = true
    skip_credentials_validation = true
    skip_metadata_api_check     = true
    skip_region_validation      = true
    skip_requesting_account_id  = true
    skip_s3_checksum            = true
  }
}

provider "cloudflare" {}

locals {
  name = "reader-cloudflare"
}

resource "cloudflare_d1_database" "app" {
  account_id            = var.account_id
  name                  = local.name
  primary_location_hint = "weur"
  read_replication = {
    mode = "disabled"
  }

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

resource "cloudflare_queue" "mutation" {
  account_id = var.account_id
  queue_name = "${local.name}-mutation"
}

resource "cloudflare_queue" "smtp" {
  account_id = var.account_id
  queue_name = "${local.name}-smtp"
}

resource "cloudflare_queue" "body" {
  account_id = var.account_id
  queue_name = "${local.name}-body"
}

resource "cloudflare_queue" "fanout" {
  account_id = var.account_id
  queue_name = "${local.name}-fanout"
}

resource "cloudflare_queue" "dlq" {
  account_id = var.account_id
  queue_name = "${local.name}-dlq"
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
  tags       = ["cf:service=${local.name}"]

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
    }, {
    id         = cloudflare_zero_trust_access_policy.agent.id
    precedence = 2
  }]

  lifecycle {
    precondition {
      condition     = local.otp_idp_id != null
      error_message = "No onetimepin identity provider is visible; the tofu token needs Access: Organizations, Identity Providers, and Groups Read, or allowed_idps would widen to every IdP."
    }
  }
}
