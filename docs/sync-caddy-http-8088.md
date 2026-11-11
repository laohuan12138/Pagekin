# Pagekin 自建同步：Caddy HTTP 8088 部署教程

本文对应服务器：

```text
203.0.113.10
/srv/pagekin-sync/sync-server
```

目标链路：

```text
客户端
  └─ http://<host>:8088
       └─ Caddy :8088
            └─ 127.0.0.1:8787  (pagekin-sync 容器)
```

> **安全警告**
>
> 这是明文 HTTP。`SYNC_TOKEN`、作品快照、lease 信息都会以明文经过公网。
> 只允许在以下场景使用：
>
> - 云防火墙把 8088 限制为你的固定客户端 IP；或
> - 通过 SSH 隧道 / Tailscale / WireGuard 访问；或
> - 仅在可信内网使用。
>
> 不要把 8088 无限制暴露给整个互联网。

## 1. 服务器现状

```text
Debian 12
Caddy 2.6.2
Nginx 占用 80
pagekin-sync 监听 127.0.0.1:8787
```

Caddy 只监听 8088，不占用 80/443，也不申请证书。

## 2. Caddyfile

文件：`/etc/caddy/Caddyfile`

```caddyfile
{
    auto_https off
}

:8088 {
    reverse_proxy 127.0.0.1:8787 {
        header_up Host {host}
        header_up X-Forwarded-For {remote_host}
        header_up X-Forwarded-Proto {scheme}
    }
}
```

说明：

| 配置 | 作用 |
|---|---|
| `auto_https off` | 关闭自动 HTTPS，不尝试绑定 80/443 |
| `:8088` | 在所有网卡的 8088 上提供 HTTP |
| `reverse_proxy 127.0.0.1:8787` | 转发到本机同步服务 |
| `X-Forwarded-For {remote_host}` | 用真实客户端 IP 覆盖 XFF，防止伪造 |
| `X-Forwarded-Proto {scheme}` | 传递原始协议 |

## 3. 应用配置

```bash
sudo caddy fmt --overwrite /etc/caddy/Caddyfile
sudo caddy validate --config /etc/caddy/Caddyfile
sudo systemctl restart caddy
sudo systemctl status caddy --no-pager
```

确认监听：

```bash
sudo ss -lntp | grep 8088
```

预期：

```text
LISTEN ... 0.0.0.0:8088 ... caddy
```

## 4. 同步服务信任代理

编辑：

```bash
cd /srv/pagekin-sync/sync-server
```

确认 `.env` 包含：

```dotenv
SYNC_TOKEN=<原有令牌，不要改>
SYNC_TRUST_PROXY=1
```

重启容器：

```bash
sudo docker-compose up -d --force-recreate
sudo docker-compose ps
```

`SYNC_TRUST_PROXY=1` 只有在反向代理覆盖 `X-Forwarded-For` 时才可开启。本文的 Caddy 配置已经覆盖。

端口仍应保持只绑本机：

```yaml
ports:
  - "127.0.0.1:8787:8787"
```

## 5. 云防火墙

阿里云安全组放行：

```text
入方向 TCP 8088
来源：你的客户端公网 IP/32
```

不要放行 8787。不要放行全部来源，除非你明确接受明文公网暴露。

## 6. 验证

服务器本机：

```bash
cd /srv/pagekin-sync/sync-server
TOKEN="$(grep '^SYNC_TOKEN=' .env | cut -d= -f2-)"

curl -i -H "Authorization: Bearer $TOKEN" \
  http://127.0.0.1:8088/health
```

预期：

```json
{"ok":true}
```

无令牌应返回 401：

```bash
curl -i http://127.0.0.1:8088/health
```

公网验证：

```bash
curl -i -H "Authorization: Bearer $TOKEN" \
  http://203.0.113.10:8088/health
```

如果本机通、公网不通，检查阿里云安全组和服务器防火墙。

## 7. 客户端地址

当前客户端源码已允许公网 HTTP 地址，可直接填：

```text
http://203.0.113.10:8088
```

也可以使用主机名：

```text
http://203.0.113.10.sslip.io:8088
http://203.0.113.10.nip.io:8088
```

修改源码后需要重新构建/安装客户端；旧版本仍会拒绝公网 HTTP。

### 可选：SSH 隧道

本机执行并保持窗口打开：

```bash
ssh -N -L 8088:127.0.0.1:8088 user@203.0.113.10
```

客户端填：

```text
http://127.0.0.1:8088
```

流量由 SSH 加密，不需要证书。

## 8. 客户端配置步骤

首次上传：

1. 打开作品。
2. 设置 → 项目备份 → 自建同步服务。
3. 服务器地址填 `http://203.0.113.10:8088`。
4. 访问令牌填 `.env` 里的 `SYNC_TOKEN`。
5. 保存并检查。
6. 绑定远端作品。
7. 获取写锁。
8. 上传当前作品快照。

新电脑书库为空时，项目备份页仍然显示“自建同步恢复”：

1. 设置 → 项目备份 → 自建同步恢复。
2. 填服务器地址、访问令牌、远端作品标识。
3. 连接并读取版本。
4. 第一次选择一个新目录，下载并恢复为新副本。
5. 之后该远端作品会显示“更新已恢复副本”；直接覆盖上次恢复的目录，不再询问文件夹。
6. 覆盖前旧副本会保留为同级的 `.pagekin-sync-backup` 目录。
7. 要更新副本时，先在书房关闭该项目，再进入“自建同步恢复”。

不会无限创建副本；只有选择“另存为新副本”才会要求新目录。

## 9. 快照保留

服务器默认最多保留 500 个快照；达到上限后上传会返回 `SNAPSHOT_LIMIT_REACHED`。

当前服务器已启用自动保留最近 100 个：

```dotenv
SYNC_RETAIN_SNAPSHOTS=100
```

行为：

- 每次成功上传后，最旧的快照会被删除，只保留最近 100 个。
- 当前 HEAD 永远不会被删除。
- 设为 `0` 可关闭自动清理，恢复“达到 500 才报错”的行为。
- 该值必须小于 `SYNC_MAX_SNAPSHOTS`。
- 旧快照文件删除后不可恢复；需要长期保留的版本应先下载成本地副本。

修改后重启：

```bash
cd /srv/pagekin-sync/sync-server
sudo docker-compose up -d --build
sudo docker-compose ps
```

## 10. 运维

查看 Caddy 日志：

```bash
sudo journalctl -u caddy -f
```

修改配置后：

```bash
sudo caddy validate --config /etc/caddy/Caddyfile
sudo systemctl reload caddy
```

查看同步容器：

```bash
cd /srv/pagekin-sync/sync-server
sudo docker-compose ps
sudo docker-compose logs --tail=100 pagekin-sync
```

轮换令牌：

```bash
cd /srv/pagekin-sync/sync-server
NEW_TOKEN="$(openssl rand -hex 32)"
sed -i "s/^SYNC_TOKEN=.*/SYNC_TOKEN=$NEW_TOKEN/" .env
sudo docker-compose up -d --force-recreate
```

然后更新所有客户端。

## 10. 风险清单

| 风险 | 说明 |
|---|---|
| 令牌明文 | HTTP 下 bearer token 可被链路中间人读取 |
| 作品明文 | 快照包含正文、配置和资产，未端到端加密 |
| 重放/篡改 | 没有 TLS 时无法保证完整性和保密性 |
| 扫描 | 公网扫描器会访问 8088，认证会返回 401/429 |
| 令牌即全权限 | 拿到令牌即可读写所有项目 |

如果后续愿意加 HTTPS，最省事的是：

1. 申请一个域名；
2. 把域名解析到 `203.0.113.10`；
3. Caddy 改为 `sync.example.com:8088` 并开启自动 HTTPS；或
4. 直接在现有 Nginx 的 443 上加 vhost 反代到 `127.0.0.1:8787`。

## 11. 回滚

恢复原 Caddyfile：

```bash
sudo cp /etc/caddy/Caddyfile.bak /etc/caddy/Caddyfile
sudo systemctl restart caddy
```

关闭代理并只保留本机同步：

```bash
sudo systemctl stop caddy
```

同步服务本身不受影响，仍监听 `127.0.0.1:8787`。
