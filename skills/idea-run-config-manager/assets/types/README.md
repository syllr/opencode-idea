# run configuration 类型模板

**一份 = 一个类型**,内容只收**实物验证过**的写法。照模板写 `.run/<配置名>.run.xml`;**没有模板的类型 → 不要自己写,交给用户在 IDE 里配**。

## 硬性契约(所有类型都一样)

1. **落地位置**:项目根的 `.run/<配置名>.run.xml`(配置名带空格就原样用,例如 `Hello World.run.xml`)。子项目的配置写在**子项目自己的** `.run/` 下,并用**子项目前缀**的工具复查。
2. **信封固定**:

   ```xml
   <component name="ProjectRunConfigurationManager">
     <configuration default="false" name="<配置名>" type="<类型ID>">
       …该类型自己的字段…
       <method v="2" />
     </configuration>
   </component>
   ```

   `factoryName="<类型名>"` **可写可不写** —— 实物里两种都有,IDE 认的是 `type`。

3. **`type` 写错 = 整个文件被静默忽略,日志里也不报任何东西。** 每种类型都得有一份实测模板,就是为了不靠猜。
4. **写完必须复查**:用 `<前缀>_get_run_configurations` 确认新配置真的出现在列表里。**没出现就是文件没被认**(type / 位置 / 信封错了),这时候别继续往下走,先回去查这三样。
5. **路径宏**:`$PROJECT_DIR$` = 该项目根。同一台机器上的多个项目靠它区分,别写绝对路径。
6. **不要加本类型没有的字段**:多余的字段被忽略,名字写错则静默用默认值 —— 两种都不会报错,但会得到一个"看起来配好了其实没生效"的配置。

## 支持矩阵

| 类型              | `type` id                       | 模板                       | 验证程度                                  |
| ----------------- | ------------------------------- | -------------------------- | ----------------------------------------- |
| Shell Script      | `ShConfigurationType`           | [shell.md](shell.md)       | ✅ 实物(本机 6 例,含 Windows)             |
| Maven             | `MavenRunConfiguration`         | [maven.md](maven.md)       | ✅ 实物                                   |
| Gradle            | `GradleRunConfiguration`        | [gradle.md](gradle.md)     | ✅ 实物                                   |
| npm / yarn / pnpm | `js.build_tools.npm`            | [npm.md](npm.md)           | ✅ 实物                                   |
| Python            | `PythonConfigurationType`       | [python.md](python.md)     | ✅ 实物                                   |
| Go Build          | `GoApplicationRunConfiguration` | [go-build.md](go-build.md) | ✅ 实物                                   |
| Node.js           | `NodeJSConfigurationType`       | [node.md](node.md)         | ⚠️ `type` 与三个属性已验证,其余字段未验证 |
| Application       | `Application`                   | —                          | ⏳ `type` 已验证,**字段层无实物**         |
| JAR               | `JarApplication`                | —                          | ⏳ 同上                                   |

**矩阵之外一律没有模板** —— JUnit / TestNG / Kotlin / Docker / Spring Boot / Tomcat / Flyway / Liquibase / HTTP Request 等等,遇到就交给用户在 IDE 里配。

## 怎么给某个类型补模板

1. 在 IDE 里用该类型建一个配置(填最简:能跑起来即可),勾 **Store as project file**;
2. 读项目里生成的 `.run/*.run.xml`,**照抄结构**,只把项目相关的值换成占位说明;
3. 标清哪些字段是实测的、哪些是留空安全的,写进对应 `types/<类型>.md`;
4. 在上面矩阵里把状态从 ⏳ 改成 ✅。

**不要凭字段名猜** —— 本目录里的每个字段名都来自真实文件。
