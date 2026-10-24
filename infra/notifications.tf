resource "cloudflare_notification_policy" "usage" {
  for_each = var.usage_alert_limits

  account_id  = var.account_id
  name        = "${local.name} ${each.key}"
  description = "Billing period usage of ${each.key} reached ${format("%d", each.value)}."
  alert_type  = "billing_usage_alert"
  enabled     = true

  filters = {
    product = [each.key]
    limit   = [format("%d", each.value)]
  }

  mechanisms = {
    email = [{ id = var.alert_email }]
  }
}
