# 联运争议证据的分层取件和封存的演练来源

这里提供独立来源的本地合成记录，与实际单位、个人和线上业务无关。

## 本地运行

使用 Node.js 22.23.4。只使用 Node.js 自带的运行库。

执行 `npm test` 检查合成来源的接口。执行 `npm start` 启动来源，默认监听 `127.0.0.1:4100`，可通过环境变量 `PORT` 调整端口。访问根路径可看到来源名和当前回放阶段。

## 接口资料

| GET 路由 | 来源约定 |
| --- | --- |
| `/source/carriers` | declaration 只关联一个运程交接。content 是声明的原件摘要；当事人及案卷双方的权限独立。 |
| `/source/depot` | pieces 按列出的次序拼接原始字节后核对摘要。withdraw 以 entrance 为作用域。 |
| `/source/service` | served 关联案卷、当事人、声明版本和原文摘要。sealed 是书记员封卷时的原有状态。 |

查询参数 `offset` 是从零开始的页偏移，`limit` 默认 3，取值 1 至 100。响应中的 `records` 含 `record` 来源记录键、`availableFrom` 首次出现的回放阶段、`kind` 记录类型、`payload` 业务字段。来源记录键与业务身份分别定义。`next` 为下一页偏移，末页为 `null`。回放阶段中的记录按到达顺序可查。

控制员通过 `POST /control?stage=2` 切换到第 2 阶段，服务会保留更早已可查的记录。每次换阶段后按根路径返回的 `stage` 确认切换成功。原件通过 `GET /original/文件名` 领取，阶段内尚不可领时返回 404。原件文件和摘要记录在 `originals/` 与来源索引。
