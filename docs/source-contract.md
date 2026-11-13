# 浏览适配器
该接口是设备 OPC UA SDK 的本地 HTTP 适配层，不是 OPC UA 二进制服务器。`/namespaces` 返回索引到 URI 的映射，`/browse?node=` 和 `/next?handle=` 返回引用及续读句柄，`/release?handle=` 释放句柄。最多同时存在两个句柄。
`/read?node=` 查看对象、变量或类型元数据；`/reorder` 模拟命名空间编号重排并销毁句柄。图含共享子节点与环，Root、Pump、Alias、Shared、Value、Samples 和类型节点可逐个查看。HasSubtype 返回本适配层声明的上级类型方向。
元数据示例：Value 是匿名显示名的标量变量（Double，可读，未提供数组维数）；Samples 是一维数组变量（arrayDimensions [4]，不可读）；两者经 HasTypeDefinition 指向 PressureType，单位 kPa 声明在 PressureType 上，BaseVariableType 不声明单位。读取不存在的节点返回错误。
