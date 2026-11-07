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
  prod = var.stage == "prod"
  name = local.prod ? var.project : "${var.project}-${var.stage}"
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

resource "cloudflare_r2_bucket_lifecycle" "mail" {
  account_id  = var.account_id
  bucket_name = cloudflare_r2_bucket.mail.name
  rules = [{
    id         = "expire-exports"
    enabled    = true
    conditions = { prefix = "exports/" }
    delete_objects_transition = {
      condition = { type = "Age", max_age = 30 * 24 * 60 * 60 }
    }
    abort_multipart_uploads_transition = {
      condition = { type = "Age", max_age = 24 * 60 * 60 }
    }
  }]
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

removed {
  from = cloudflare_secrets_store.this

  lifecycle {
    destroy = false
  }
}

data "cloudflare_secrets_stores" "all" {
  account_id = var.account_id
}

locals {
  secrets_store_id = one([
    for store in data.cloudflare_secrets_stores.all.result : store.id if store.name == var.project
  ])
  master_key_secret_name = local.prod ? "MASTER_KEY" : "${upper(var.stage)}_MASTER_KEY"
}

resource "random_bytes" "master_key" {
  length = 32
}

resource "cloudflare_secrets_store_secret" "master_key" {
  account_id = var.account_id
  store_id   = local.secrets_store_id
  name       = local.master_key_secret_name
  value      = random_bytes.master_key.base64
  scopes     = ["workers"]
  comment    = "Master encryption key for ${local.name}"

  lifecycle {
    prevent_destroy = true

    precondition {
      condition     = local.secrets_store_id != null
      error_message = "No Secrets Store named ${var.project}; run tofu-bootstrap ${var.project} --secrets-store."
    }
  }
}

import {
  for_each = local.prod ? toset([var.project]) : toset([])
  to       = cloudflare_worker.reader
  id       = "${var.account_id}/${each.value}"
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
  include = [for email in var.owner_emails : {
    email = {
      email = email
    }
  }]
}

resource "cloudflare_zero_trust_access_application" "reader" {
  account_id = var.account_id
  name       = local.name
  type       = "self_hosted"
  domain     = var.app_hostname
  destinations = [{
    type = "public"
    uri  = var.app_hostname
  }]
  session_duration          = var.login_idp ? "15m" : "720h"
  auto_redirect_to_identity = !var.login_idp
  enable_binding_cookie     = false
  options_preflight_bypass  = false
  allowed_idps              = local.reader_allowed_idps
  policies = concat(
    var.login_idp ? [{ id = cloudflare_zero_trust_access_policy.login.id, precedence = 1 }] : [],
    [
      { id = cloudflare_zero_trust_access_policy.owner.id, precedence = var.login_idp ? 2 : 1 },
      { id = cloudflare_zero_trust_access_policy.agent.id, precedence = var.login_idp ? 3 : 2 },
    ],
  )

  lifecycle {
    precondition {
      condition     = local.otp_idp_id != null
      error_message = "No onetimepin identity provider is visible; the tofu token needs Access: Organizations, Identity Providers, and Groups Read, or allowed_idps would widen to every IdP."
    }
    precondition {
      condition     = length(local.reader_allowed_idps) > 0 && length(setsubtract(local.reader_allowed_idps, local.stage_idps)) == 0
      error_message = "Access application ${local.name} must list allowed_idps, drawn only from the one-time PIN and this stage's login IdP."
    }
    precondition {
      condition     = length(setintersection(local.reader_allowed_idps, local.other_stage_login_idps)) == 0
      error_message = "Access application ${local.name} must not allow ${local.other_stage_login_idp}, the other stage's login IdP."
    }
    precondition {
      condition     = var.app_hostname != var.login_hostname
      error_message = "Access application ${local.name} must not cover the login hostname."
    }
  }
}

data "cloudflare_zero_trust_organization" "this" {
  account_id = var.account_id
}
