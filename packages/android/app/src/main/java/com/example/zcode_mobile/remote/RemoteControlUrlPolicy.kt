package com.example.zcode_mobile.remote

import android.net.Uri
import com.example.zcode_mobile.BuildConfig

private const val ZCODE_REMOTE_SCHEME = "xatlas"
private const val ZCODE_REMOTE_HOST = "remote"

object RemoteControlUrlPolicy {
    fun resolve(raw: String?): String? {
        val trimmed = raw?.trim().orEmpty()
        if (trimmed.isEmpty()) {
            return null
        }

        val uri = runCatching { Uri.parse(trimmed) }.getOrNull() ?: return null
        return resolve(uri)
    }

    fun resolve(uri: Uri?): String? {
        if (uri == null) {
            return null
        }

        if (uri.scheme == ZCODE_REMOTE_SCHEME && uri.host == ZCODE_REMOTE_HOST) {
            // xatlas://remote?link=<pairing link>, the same link format the iOS app opens.
            uri.getQueryParameter("link")?.let { link -> return resolve(link) }
            return buildDefaultRemoteUrl(uri)
        }

        if (isAllowedRemoteUrl(uri)) {
            return uri.toString()
        }

        return null
    }

    fun isAllowedRemoteUrl(raw: String?): Boolean {
        val uri = runCatching { Uri.parse(raw?.trim().orEmpty()) }.getOrNull() ?: return false
        return isAllowedRemoteUrl(uri)
    }

    private fun buildDefaultRemoteUrl(uri: Uri): String {
        val base = Uri.parse(BuildConfig.REMOTE_CONTROL_DEFAULT_URL).buildUpon()
        uri.encodedQuery?.let { base.encodedQuery(it) }
        uri.encodedFragment?.let { base.encodedFragment(it) }
        return base.build().toString()
    }

    private fun isAllowedRemoteUrl(uri: Uri): Boolean {
        val scheme = uri.scheme?.lowercase()
        val host = uri.host?.lowercase().orEmpty()
        val path = uri.path.orEmpty()

        val remoteHost = Uri.parse(BuildConfig.REMOTE_CONTROL_DEFAULT_URL).host?.lowercase()
        if (scheme == "https" && host == remoteHost && path.startsWith("/remote")) {
            return true
        }

        // The desktop app serves the remote itself, so the link points at the Mac on the
        // local network or the user's Tailscale network. Nothing else opens in the app.
        if (!path.startsWith("/remote")) {
            return false
        }
        if (host == remoteHost) {
            return scheme == "https"
        }
        return (scheme == "http" || scheme == "https") && isLocalNetworkHost(host)
    }

    private fun isLocalNetworkHost(host: String): Boolean {
        if (host == "localhost" || host == "127.0.0.1" || host == "10.0.2.2") {
            return true
        }
        if (host.endsWith(".local")) {
            return true
        }
        if (host.startsWith("192.168.") || host.startsWith("10.") || host.startsWith("169.254.")) {
            return true
        }
        if (Regex("^100\\.(6[4-9]|[7-9]\\d|1[01]\\d|12[0-7])\\.").containsMatchIn(host)) {
            return true
        }
        return Regex("^172\\.(1[6-9]|2\\d|3[0-1])\\.").containsMatchIn(host)
    }
}
