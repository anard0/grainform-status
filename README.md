# Grainform service status

Public endpoint reachability only. No application source, customer data or credentials.

Public address: https://status.grainform.app/. GitHub Pages owns the custom-domain setting; Cloudflare has a DNS-only `status` CNAME to `anard0.github.io`. The app's `/status` route redirects here. Get help opens https://grainform.app/help.

Checks run at minutes 7 and 37 each hour and publish a dated report even when a check fails.
Results expire after two hours. This does not prove OAuth, project saves or payment completion.
GitHub scheduled runs can be delayed and pause after 60 days without repository activity.
