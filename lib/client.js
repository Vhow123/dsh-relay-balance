// 中转站余额角标（浏览器半部）— DSH ModuleLoader 格式的客户端 bundle
//
// 数据通道：fetch 宿主半部的 /relay-balance 接口（宿主负责凭证与上游调用，
// 浏览器侧永不接触 access_token / refresh_token 明文）。
// UI：
//   - 界面角落一枚余额胶囊（shell.overlay 席位，可拖动、位置本地记忆）
//   - 点击展开：多站点列表（增删改 / 单站刷新 / 单站测试）+ 全局设置
//   - 角标显示模式：合计余额 / 当前站点 / 多站点轮播
// 与 cordis.patch.yml 中本 bundle 的行 id 保持一致（relay-balance）。
window.__ModuleLoader__.load({
	id: "dsh-relay-balance",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		var react = require("react");
		var h = react.createElement;

		var API = "/relay-balance";
		var POS_KEY = "dsh-relay-balance:pos";
		var POLL_MS = 30000;
		var ROTATE_MS = 4000;
		var BASE_INSET = 18;
		var CORNERS = ["br", "bl", "tr", "tl"];

		// ---------- 位置（角落锚点 + 拖拽偏移，本地记忆） ----------
		function loadPos() {
			var fallback = { corner: "br", dx: 0, dy: 0 };
			try {
				var raw = window.localStorage.getItem(POS_KEY);
				if (!raw) return fallback;
				var parsed = JSON.parse(raw);
				if (!parsed || CORNERS.indexOf(parsed.corner) < 0) return fallback;
				return {
					corner: parsed.corner,
					dx: Number.isFinite(parsed.dx) ? parsed.dx : 0,
					dy: Number.isFinite(parsed.dy) ? parsed.dy : 0
				};
			} catch (err) {
				return fallback;
			}
		}

		function savePos(pos) {
			try {
				window.localStorage.setItem(POS_KEY, JSON.stringify(pos));
			} catch (err) {
				/* 无痕模式等场景：位置不记忆即可，不影响功能 */
			}
		}

		// 拖拽方向 → 锚点偏移方向的符号（right/bottom 锚定时屏幕正向位移对应负偏移）
		function anchorSigns(corner) {
			return {
				sx: corner === "br" || corner === "tr" ? -1 : 1,
				sy: corner === "br" || corner === "bl" ? -1 : 1
			};
		}

		function anchorStyle(pos) {
			var style = { position: "fixed", zIndex: 30 };
			var horizontal = pos.corner === "br" || pos.corner === "tr" ? "right" : "left";
			var vertical = pos.corner === "br" || pos.corner === "bl" ? "bottom" : "top";
			style[horizontal] = BASE_INSET + pos.dx + "px";
			style[vertical] = BASE_INSET + pos.dy + "px";
			return style;
		}

		// ---------- 展示格式 ----------
		function fmtMoney(value) {
			if (value === null || value === undefined || value === "") return "--";
			var n = Number(value);
			if (!Number.isFinite(n)) return "--";
			var digits = Math.abs(n) >= 1 ? 2 : 4;
			return n.toLocaleString(undefined, { minimumFractionDigits: digits, maximumFractionDigits: digits });
		}

		/** 站点金额文案：未配置或上游没给出数字都显示 --，绝不把 null 当成 0 */
		function moneyOf(site) {
			if (!site || !site.configured) return "--";
			if (typeof site.balance !== "number" || !Number.isFinite(site.balance)) return "--";
			return "$" + fmtMoney(site.balance);
		}

		/** 合计金额文案：一个有效余额都没有时不显示 $ */
		function totalOf(state) {
			if (!state || typeof state.totalBalance !== "number" || !Number.isFinite(state.totalBalance)) return null;
			return fmtMoney(state.totalBalance);
		}

		function fmtTime(iso) {
			if (!iso) return "—";
			var ts = Date.parse(iso);
			if (!Number.isFinite(ts)) return "—";
			return new Date(ts).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", second: "2-digit" });
		}

		function hostOf(url) {
			try {
				return new URL(url).host;
			} catch (err) {
				return String(url || "").replace(/^https?:\/\//i, "");
			}
		}

		function siteList(data) {
			return data && Array.isArray(data.sites) ? data.sites : [];
		}

		function configuredSites(data) {
			return siteList(data).filter(function (site) {
				return site.configured;
			});
		}

		function siteById(data, id) {
			var found = siteList(data).filter(function (site) {
				return site.id === id;
			});
			return found[0] || null;
		}

		function statusOfSite(site) {
			if (!site.configured) return "idle";
			return site.status || "idle";
		}

		function siteStatusText(site) {
			if (!site.configured) return "未配置凭证";
			if (site.status === "ok") return "正常";
			if (site.status === "loading") return "查询中";
			if (site.status === "error") return site.error || "读取失败";
			return "待刷新";
		}

		// ---------- 样式 ----------
		var S = {
			badge: {
				display: "inline-flex",
				alignItems: "center",
				gap: "7px",
				height: "30px",
				padding: "0 11px",
				borderRadius: "999px",
				border: "0.5px solid var(--dsw-alias-border-l4, rgba(0,0,0,.12))",
				background: "var(--dsw-alias-bg-layer-2, #ffffff)",
				boxShadow: "var(--dsw-elevation-prominent, 0 6px 20px rgba(0,0,0,.14))",
				color: "var(--dsw-alias-label-primary, #1a1a1a)",
				fontSize: "12px",
				lineHeight: "18px",
				fontVariantNumeric: "tabular-nums",
				cursor: "pointer",
				userSelect: "none",
				whiteSpace: "nowrap"
			},
			dot: { width: "7px", height: "7px", borderRadius: "999px", flex: "none" },
			label: { color: "var(--dsw-alias-label-tertiary, #8a8a8a)", maxWidth: "96px", overflow: "hidden", textOverflow: "ellipsis" },
			amount: { fontWeight: 600, letterSpacing: "0.01em" },
			panel: {
				position: "absolute",
				width: "324px",
				boxSizing: "border-box",
				padding: "14px",
				borderRadius: "var(--dsw-radius-panel, 16px)",
				border: "0.5px solid var(--dsw-alias-border-l3, rgba(0,0,0,.1))",
				background: "var(--dsw-alias-bg-layer-2, #ffffff)",
				boxShadow: "var(--dsw-elevation-prominent, 0 12px 32px rgba(0,0,0,.18))",
				color: "var(--dsw-alias-label-primary, #1a1a1a)",
				fontSize: "12px",
				lineHeight: "18px",
				cursor: "default"
			},
			panelHead: { display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: "8px" },
			panelTitle: { fontSize: "13px", fontWeight: 600 },
			panelMeta: { color: "var(--dsw-alias-label-tertiary, #8a8a8a)", fontSize: "11px" },
			bigAmount: { fontSize: "24px", fontWeight: 600, letterSpacing: "-0.01em", margin: "8px 0 2px" },
			bigUnit: { fontSize: "13px", fontWeight: 500, color: "var(--dsw-alias-label-secondary, #5c5c5c)" },
			row: { display: "flex", justifyContent: "space-between", gap: "10px", padding: "3px 0" },
			rowKey: { color: "var(--dsw-alias-label-tertiary, #8a8a8a)", flex: "none" },
			rowVal: { color: "var(--dsw-alias-label-primary, #1a1a1a)", textAlign: "right", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
			divider: { height: "0.5px", background: "var(--dsw-alias-border-l4, rgba(0,0,0,.1))", margin: "11px 0" },
			sectionTitle: { color: "var(--dsw-alias-label-secondary, #5c5c5c)", fontSize: "11px", marginBottom: "6px", display: "flex", justifyContent: "space-between", alignItems: "center" },
			siteRow: {
				padding: "7px 8px",
				borderRadius: "var(--dsw-radius-md, 8px)",
				background: "var(--dsw-alias-bg-layer-1, rgba(0,0,0,.02))",
				marginBottom: "6px"
			},
			siteLine: { display: "flex", alignItems: "center", gap: "7px" },
			siteName: { fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", flex: "1" },
			siteAmount: { fontWeight: 600, fontVariantNumeric: "tabular-nums", flex: "none" },
			siteMeta: { display: "flex", alignItems: "center", gap: "6px", marginTop: "3px", paddingLeft: "14px" },
			siteMetaText: {
				color: "var(--dsw-alias-label-tertiary, #8a8a8a)",
				fontSize: "11px",
				overflow: "hidden",
				textOverflow: "ellipsis",
				whiteSpace: "nowrap",
				flex: "1"
			},
			linkBtn: {
				border: "none",
				background: "transparent",
				color: "var(--dsw-alias-label-tertiary, #8a8a8a)",
				fontSize: "11px",
				padding: "0 2px",
				cursor: "pointer",
				flex: "none"
			},
			linkBtnDanger: { color: "var(--dsw-alias-state-error-primary, #dc2626)" },
			field: { marginBottom: "9px" },
			fieldLabel: { display: "block", color: "var(--dsw-alias-label-secondary, #5c5c5c)", marginBottom: "4px" },
			input: {
				width: "100%",
				boxSizing: "border-box",
				height: "28px",
				padding: "0 8px",
				borderRadius: "var(--dsw-radius-md, 8px)",
				border: "0.5px solid var(--dsw-alias-border-l4, rgba(0,0,0,.12))",
				background: "var(--dsw-alias-bg-layer-1, #fafafa)",
				color: "var(--dsw-alias-label-primary, #1a1a1a)",
				fontSize: "12px",
				outline: "none"
			},
			btn: {
				height: "26px",
				padding: "0 10px",
				borderRadius: "var(--dsw-radius-md, 8px)",
				border: "0.5px solid var(--dsw-alias-border-l4, rgba(0,0,0,.12))",
				background: "transparent",
				color: "var(--dsw-alias-label-primary, #1a1a1a)",
				fontSize: "12px",
				cursor: "pointer"
			},
			btnPrimary: {
				height: "26px",
				padding: "0 12px",
				borderRadius: "var(--dsw-radius-md, 8px)",
				border: "none",
				background: "var(--dsw-alias-state-business-primary, #4d6bfe)",
				color: "#ffffff",
				fontSize: "12px",
				fontWeight: 500,
				cursor: "pointer"
			},
			chipRow: { display: "flex", gap: "4px" },
			chip: {
				flex: "1",
				height: "24px",
				borderRadius: "var(--dsw-radius-sm, 6px)",
				border: "0.5px solid var(--dsw-alias-border-l4, rgba(0,0,0,.12))",
				background: "transparent",
				color: "var(--dsw-alias-label-secondary, #5c5c5c)",
				fontSize: "11px",
				cursor: "pointer"
			},
			chipActive: {
				background: "var(--dsw-alias-interactive-bg-hover, rgba(0,0,0,.06))",
				color: "var(--dsw-alias-label-primary, #1a1a1a)",
				borderColor: "var(--dsw-alias-border-l3, rgba(0,0,0,.16))"
			},
			checkRow: { display: "flex", alignItems: "center", gap: "6px", cursor: "pointer" },
			hint: { color: "var(--dsw-alias-label-tertiary, #8a8a8a)", fontSize: "11px", lineHeight: "16px", marginTop: "2px" },
			msg: { fontSize: "11px", marginTop: "8px", lineHeight: "16px", wordBreak: "break-all" },
			footer: { display: "flex", justifyContent: "flex-end", gap: "6px", marginTop: "10px" }
		};

		var DOT_COLOR = {
			ok: "var(--dsw-alias-state-success-primary, #16a34a)",
			partial: "var(--dsw-alias-state-warn-primary, #d97706)",
			loading: "var(--dsw-alias-state-warn-primary, #d97706)",
			error: "var(--dsw-alias-state-error-primary, #dc2626)",
			idle: "var(--dsw-alias-label-tertiary, #9a9a9a)"
		};

		var TONE_COLOR = {
			ok: "var(--dsw-alias-state-success-primary, #16a34a)",
			err: "var(--dsw-alias-state-error-primary, #dc2626)",
			info: "var(--dsw-alias-label-secondary, #5c5c5c)",
			warn: "var(--dsw-alias-state-warning-primary, #d97706)"
		};

		// ---------- 请求 ----------
		function fetchState(opts) {
			var force = Boolean(opts && opts.force);
			var id = opts && opts.id;
			var query = [];
			if (force) query.push("refresh=1");
			if (id) query.push("id=" + encodeURIComponent(id));
			var url = API + "/state" + (query.length ? "?" + query.join("&") : "");
			return window
				.fetch(url, { headers: { Accept: "application/json" } })
				.then(function (res) {
					if (res.status === 404) throw new Error("宿主接口未就绪，请重启 dsh");
					return res.json();
				})
				.then(function (body) {
					if (!body || body.ok !== true) throw new Error((body && body.message) || "状态接口返回异常");
					return body.state;
				});
		}

		function postJson(path, body) {
			return window
				.fetch(API + path, {
					method: "POST",
					headers: { "Content-Type": "application/json", Accept: "application/json" },
					body: JSON.stringify(body || {})
				})
				.then(function (res) {
					return res.json();
				});
		}

		// ---------- 站点表单（新增 / 编辑共用） ----------
		function SiteForm(props) {
			var site = props.site || null;
			var defaults = props.defaults || {};

			var draftHook = react.useState(function () {
				return {
					name: site ? site.name : "",
					baseUrl: site ? site.baseUrl : defaults.baseUrl || "",
					loginMode: site ? site.loginMode || "token" : "password",
					loginEmail: site ? site.loginEmail || "" : "",
					password: "",
					code: "",
					rememberPassword: site ? site.rememberPassword !== false : true,
					accessToken: "",
					refreshToken: "",
					enabled: site ? site.enabled : true
				};
			});
			var draft = draftHook[0];
			var setDraft = draftHook[1];

			var busyHook = react.useState("");
			var busy = busyHook[0];
			var setBusy = busyHook[1];

			var msgHook = react.useState(null);
			var msg = msgHook[0];
			var setMsg = msgHook[1];

			// 站点登录前置条件（是否强制人机验证）——只用来提示，不阻塞任何操作
			var capsHook = react.useState(null);
			var caps = capsHook[0];
			var setCaps = capsHook[1];

			// 面板方言（sub2api / newapi）——决定字段标签、提示文案与凭证种类
			var flavorHook = react.useState(site ? site.flavor || null : null);
			var flavor = flavorHook[0];
			var setFlavor = flavorHook[1];
			var isNewApi = flavor === "newapi";

			// 上游要求两步验证时暂存 temp_token，表单就地切换成验证码输入
			var twoFaHook = react.useState(null);
			var twoFa = twoFaHook[0];
			var setTwoFa = twoFaHook[1];

			react.useEffect(
				function () {
					var baseUrl = (draft.baseUrl || "").trim();
					if (!/^https?:\/\//i.test(baseUrl)) {
						setCaps(null);
						setFlavor(null);
						return undefined;
					}
					var cancelled = false;
					var timer = setTimeout(function () {
						window
							.fetch(API + "/settings?baseUrl=" + encodeURIComponent(baseUrl), {
								headers: { Accept: "application/json" }
							})
							.then(function (res) {
								return res.json();
							})
							.then(function (body) {
								if (cancelled) return;
								var hit = body && body.ok;
								setCaps(hit ? body.capabilities : null);
								// 方言由宿主端探测，探不到就退回站点已存的方言（新增站点时是 null）
								setFlavor(hit && body.flavor ? body.flavor : site ? site.flavor || null : null);
							})
							.catch(function () {
								if (!cancelled) setCaps(null);
							});
					}, 400);
					return function () {
						cancelled = true;
						clearTimeout(timer);
					};
				},
				[draft.baseUrl]
			);

			function patch(key, value) {
				setDraft(function (prev) {
					var next = Object.assign({}, prev);
					next[key] = value;
					return next;
				});
			}

			function onTest() {
				setBusy("test");
				setMsg(null);
				postJson("/test", {
					id: site ? site.id : undefined,
					baseUrl: draft.baseUrl,
					accessToken: draft.accessToken,
					refreshToken: draft.refreshToken
				})
					.then(function (body) {
						if (body && body.ok) {
							var who = (body.account && (body.account.email || body.account.username)) || "账号";
							setMsg({ tone: "ok", text: "连接成功：" + who + " 余额 $" + fmtMoney(body.balance) });
							if (!draft.name && body.name) patch("name", body.name);
						} else {
							setMsg({ tone: "err", text: "连接失败：" + ((body && body.message) || "未知错误") });
						}
					})
					.catch(function (err) {
						setMsg({ tone: "err", text: "连接失败：" + (err instanceof Error ? err.message : String(err)) });
					})
					.then(function () {
						setBusy("");
					});
			}

			function onLogin() {
				setBusy("login");
				setMsg(null);
				postJson("/login", {
					id: site ? site.id : undefined,
					baseUrl: draft.baseUrl,
					name: draft.name,
					email: draft.loginEmail,
					// new-api 的登录字段名是 username，sub2api 是 email；两个都发，宿主端按方言取
					username: draft.loginEmail,
					password: draft.password,
					rememberPassword: draft.rememberPassword,
					tempToken: twoFa ? twoFa.tempToken : undefined,
					code: twoFa ? draft.code : undefined
				})
					.then(function (body) {
						if (body && body.ok === true) {
							setTwoFa(null);
							var who = (body.account && (body.account.email || body.account.username)) || draft.loginEmail;
							setMsg({ tone: "ok", text: "登录成功：" + who });
							props.onSaved(body.state, "已登录并保存");
							return;
						}
						if (body && body.need2fa) {
							setTwoFa({ tempToken: body.tempToken });
							setMsg({ tone: "warn", text: body.hint || "请输入两步验证码" });
							return;
						}
						var text =
							(body && body.error && body.error.message) || (body && body.message) || "登录失败";
						if (body && body.hint) text += " —— " + body.hint;
						setMsg({ tone: "err", text: text });
					})
					.catch(function (err) {
						setMsg({ tone: "err", text: "登录失败：" + (err instanceof Error ? err.message : String(err)) });
					})
					.then(function () {
						setBusy("");
					});
			}

			function onSave() {
				setBusy("save");
				setMsg(null);
				var payload = {
					name: draft.name,
					baseUrl: draft.baseUrl,
					enabled: draft.enabled,
					loginMode: draft.loginMode
				};
				if (draft.loginMode === "password") {
					payload.loginEmail = draft.loginEmail;
					payload.rememberPassword = draft.rememberPassword;
					// 密码留空 = 保持原值；全新站点必须给出密码
					if (draft.password) payload.password = draft.password;
					if (!draft.loginEmail || (!draft.password && !(site && site.hasPassword))) {
						setBusy("");
						setMsg({ tone: "err", text: "请填入账号与密码（或直接点「登录并保存」）" });
						return;
					}
				} else {
					// 令牌留空 = 保持原值（面板只回显 hasAccessToken，不回显明文）
					if (draft.accessToken) payload.accessToken = draft.accessToken;
					if (draft.refreshToken) payload.refreshToken = draft.refreshToken;
					if (site && !site.hasAccessToken && !site.hasSessionSid && !site.hasSessionCookie && !draft.accessToken) {
						setBusy("");
						setMsg({ tone: "err", text: "请填入 auth_token" });
						return;
					}
				}
				var request = site
					? postJson("/sites", { action: "update", id: site.id, site: payload })
					: postJson("/sites", { action: "add", site: payload });
				request
					.then(function (body) {
						if (!body || body.ok !== true) throw new Error((body && body.message) || "保存失败");
						props.onSaved(body.state, site ? "已保存" : "已添加");
					})
					.catch(function (err) {
						setMsg({ tone: "err", text: err instanceof Error ? err.message : String(err) });
					})
					.then(function () {
						setBusy("");
					});
			}

			// 凭证区随「登录方式」整块切换：账号密码模式给邮箱/密码，令牌模式给两个 token 框
			var authFields =
				draft.loginMode === "password"
					? [
							h(
								"div",
								{ style: S.field, key: "email" },
								h("label", { style: S.fieldLabel }, isNewApi ? "账号（用户名）" : "账号（邮箱）"),
								h("input", {
									style: S.input,
									value: draft.loginEmail,
									spellCheck: false,
									autoComplete: "off",
									placeholder: isNewApi ? "面板登录用户名" : "面板登录邮箱",
									onChange: function (e) {
										patch("loginEmail", e.target.value);
									}
								})
							),
							h(
								"div",
								{ style: S.field, key: "password" },
								h(
									"label",
									{ style: S.fieldLabel },
									"密码" + (site && site.hasPassword ? "（已保存，留空则不改）" : "")
								),
								h("input", {
									style: S.input,
									type: "password",
									value: draft.password,
									spellCheck: false,
									autoComplete: "off",
									placeholder: site && site.hasPassword ? "••••••••" : "面板登录密码",
									onChange: function (e) {
										patch("password", e.target.value);
									}
								})
							),
							h(
								"label",
								{ style: S.checkRow, key: "remember" },
								h("input", {
									type: "checkbox",
									checked: draft.rememberPassword,
									onChange: function (e) {
										patch("rememberPassword", e.target.checked);
									}
								}),
								"记住密码（写入本地配置文件，0600 权限）"
							),
							twoFa && !isNewApi
								? h(
										"div",
										{ style: S.field, key: "code" },
										h("label", { style: S.fieldLabel }, "两步验证码"),
										h("input", {
											style: S.input,
											value: draft.code,
											spellCheck: false,
											autoComplete: "off",
											placeholder: "验证器里的 6 位动态码",
											onChange: function (e) {
												patch("code", e.target.value);
											}
										})
									)
								: null,
							// 方言不影响这条预警：new-api 面板同样可能打开 turnstile_check
							// （实测 api.apiling.xyz 就是 new-api + turnstile），所以不能按方言门禁
							caps && caps.turnstileEnabled
								? h(
										"div",
										{ style: S.hint, key: "ts" },
										isNewApi
											? "⚠ 该站点启用了 Cloudflare 人机验证：上游在校验密码之前先校验验证码，服务端账号密码登录会被直接拒绝。这个站点请改用「手动令牌」，粘贴面板「个人设置」里的系统访问令牌（面板若没有这个入口，这个站点就接不了）。"
											: "⚠ 该站点启用了 Cloudflare 人机验证：上游在校验密码之前先校验验证码，服务端账号密码登录会被直接拒绝。这个站点请改用「手动令牌」。"
									)
								: null
						]
					: [
							h(
								"div",
								{ style: S.field, key: "at" },
								h(
									"label",
									{ style: S.fieldLabel },
									"auth_token" + (site && site.hasAccessToken ? "（已保存，留空则不改）" : "")
								),
								h("input", {
									style: S.input,
									type: "password",
									value: draft.accessToken,
									placeholder: site && site.hasAccessToken ? "••••••••" : "粘贴面板 localStorage 里的 auth_token",
									spellCheck: false,
									onChange: function (e) {
										patch("accessToken", e.target.value);
									}
								})
							),
							h(
								"div",
								{ style: S.field, key: "rt" },
								h(
									"label",
									{ style: S.fieldLabel },
									"refresh_token" +
										(site && site.hasRefreshToken ? "（已保存，留空则不改）" : "（可选，用于自动续期）")
								),
								h("input", {
									style: S.input,
									type: "password",
									value: draft.refreshToken,
									placeholder: "粘贴 refresh_token 可免去手动换 token",
									spellCheck: false,
									onChange: function (e) {
										patch("refreshToken", e.target.value);
									}
								})
							)
						];

			return h(
				"div",
				{ style: Object.assign({}, S.siteRow, { background: "var(--dsw-alias-bg-layer-3, rgba(0,0,0,.04))" }) },
				h("div", { style: S.fieldLabel }, site ? "编辑站点" : "新增站点"),
				h(
					"div",
					{ style: S.field },
					h("label", { style: S.fieldLabel }, "名称（留空自动取主机名）"),
					h("input", {
						style: S.input,
						value: draft.name,
						spellCheck: false,
						placeholder: draft.baseUrl ? hostOf(draft.baseUrl) : "例如 快乐星球",
						onChange: function (e) {
							patch("name", e.target.value);
						}
					})
				),
				h(
					"div",
					{ style: S.field },
					h("label", { style: S.fieldLabel }, "面板地址"),
					h("input", {
						style: S.input,
						value: draft.baseUrl,
						spellCheck: false,
						placeholder: "https://sub.0000.icu",
						onChange: function (e) {
							patch("baseUrl", e.target.value);
						}
					})
				),
				h(
					"div",
					{ style: S.field },
					h("label", { style: S.fieldLabel }, "登录方式"),
					h(
						"div",
						{ style: S.chipRow },
						[
							["password", "账号密码"],
							["token", "手动令牌"]
						].map(function (pair) {
							return h(
								"button",
								{
									key: pair[0],
									style: Object.assign({}, S.chip, draft.loginMode === pair[0] ? S.chipActive : null),
									onClick: function () {
										patch("loginMode", pair[0]);
									}
								},
								pair[1]
							);
						})
					)
				),
				authFields,
				h(
					"label",
					{ style: S.checkRow },
					h("input", {
						type: "checkbox",
						checked: draft.enabled,
						onChange: function (e) {
							patch("enabled", e.target.checked);
						}
					}),
					"启用该站点"
				),
				h(
					"div",
					{ style: S.hint },
					draft.loginMode === "password"
						? "账号密码只在点「登录并保存」时发给该站点面板；不勾「记住密码」则登录后只保留令牌（refresh_token 可续期约 30 天）。"
						: "取 token：登录该站点面板 → F12 → Application → Local Storage → 复制 auth_token（连同 refresh_token 更好）。"
				),
				h(
					"div",
					{ style: S.footer },
					draft.loginMode === "password"
						? h(
								"button",
								{
									style: S.btnPrimary,
									onClick: onLogin,
									disabled: busy === "login" || busy === "save" || busy === "test"
								},
								busy === "login" ? "登录中…" : twoFa ? "提交验证码" : "登录并保存"
							)
						: null,
					h(
						"button",
						{ style: S.btn, onClick: onTest, disabled: busy === "test" || busy === "save" },
						busy === "test" ? "测试中…" : "测试连接"
					),
					h("button", { style: S.btn, onClick: props.onCancel, disabled: busy === "save" }, "取消"),
					h(
						"button",
						{
							style: draft.loginMode === "password" ? S.btn : S.btnPrimary,
							onClick: onSave,
							disabled: busy === "save" || busy === "test"
						},
						busy === "save" ? "保存中…" : site ? "保存" : "添加"
					)
				),
				msg
					? h("div", { style: Object.assign({}, S.msg, { color: TONE_COLOR[msg.tone] }) }, msg.text)
					: null
			);
		}

		// ---------- 站点行 ----------
		function SiteRow(props) {
			var site = props.site;
			var status = statusOfSite(site);
			var meta = [];
			meta.push(hostOf(site.siteRoot || site.baseUrl));
			meta.push(
				site.loginMode === "password"
					? "账号密码" + (site.loginEmail ? " · " + site.loginEmail : "")
					: "手动令牌"
			);
			if (site.flavor === "newapi") meta.push("new-api");
			if (!site.enabled) meta.push("已停用");
			if (site.account && site.account.group) meta.push(String(site.account.group));
			if (site.account && site.account.concurrency !== null && site.account.concurrency !== undefined) {
				meta.push("并发 " + site.account.concurrency);
			}
			if (site.status === "ok" && site.updatedAt) meta.push("更新 " + fmtTime(site.updatedAt));
			if (site.status !== "ok") meta.push(siteStatusText(site));

			var actions = [];
			actions.push(
				h(
					"button",
					{
						key: "r",
						style: S.linkBtn,
						disabled: props.busy,
						title: "只刷新这个站点",
						onClick: function () {
							props.onRefresh(site.id);
						}
					},
					props.busy ? "刷新中" : "刷新"
				)
			);
			actions.push(
				h(
					"button",
					{
						key: "e",
						style: S.linkBtn,
						onClick: function () {
							props.onEdit(site.id);
						}
					},
					"编辑"
				)
			);
			if (props.confirmRemove) {
				actions.push(
					h(
						"button",
						{
							key: "c",
							style: Object.assign({}, S.linkBtn, S.linkBtnDanger),
							onClick: function () {
								props.onRemove(site.id);
							}
						},
						"确认删除"
					)
				);
				actions.push(
					h(
						"button",
						{
							key: "x",
							style: S.linkBtn,
							onClick: function () {
								props.onCancelRemove();
							}
						},
						"取消"
					)
				);
			} else {
				actions.push(
					h(
						"button",
						{
							key: "d",
							style: S.linkBtn,
							onClick: function () {
								props.onAskRemove(site.id);
							}
						},
						"删除"
					)
				);
			}

			return h(
				"div",
				{ style: S.siteRow },
				h(
					"div",
					{ style: S.siteLine },
					h("span", { style: Object.assign({}, S.dot, { background: DOT_COLOR[status] || DOT_COLOR.idle }) }),
					h("span", { style: S.siteName, title: site.name + " · " + site.baseUrl }, site.name),
					h("span", { style: S.siteAmount }, moneyOf(site))
				),
				h("div", { style: S.siteMeta }, h("span", { style: S.siteMetaText, title: meta.join(" · ") }, meta.join(" · ")), actions)
			);
		}

		// ---------- 全局设置 ----------
		function Settings(props) {
			var config = props.config || {};
			var intervalHook = react.useState(function () {
				return String(Math.max(15, Math.round((config.intervalMs || 60000) / 1000)));
			});
			var intervalDraft = intervalHook[0];
			var setIntervalDraft = intervalHook[1];
			var busyHook = react.useState("");
			var busy = busyHook[0];
			var setBusy = busyHook[1];

			react.useEffect(
				function () {
					setIntervalDraft(String(Math.max(15, Math.round((config.intervalMs || 60000) / 1000))));
				},
				[config.intervalMs]
			);

			function apply(patch) {
				setBusy("save");
				postJson("/config", patch)
					.then(function (body) {
						if (!body || body.ok !== true) throw new Error((body && body.message) || "保存失败");
						props.onSaved(body.state);
					})
					.catch(function (err) {
						props.onMessage({ tone: "err", text: err instanceof Error ? err.message : String(err) });
					})
					.then(function () {
						setBusy("");
					});
			}

			var configured = (props.sites || []).filter(function (site) {
				return site.configured;
			});

			var cornerChips = [
				["tl", "左上"],
				["tr", "右上"],
				["bl", "左下"],
				["br", "右下"]
			].map(function (pair) {
				return h(
					"button",
					{
						key: pair[0],
						style: Object.assign({}, S.chip, config.corner === pair[0] ? S.chipActive : null),
						onClick: function () {
							apply({ corner: pair[0] });
						}
					},
					pair[1]
				);
			});

			var modeChips = [
				["total", "合计"],
				["active", "当前站"],
				["rotate", "轮播"]
			].map(function (pair) {
				return h(
					"button",
					{
						key: pair[0],
						style: Object.assign({}, S.chip, config.badgeMode === pair[0] ? S.chipActive : null),
						onClick: function () {
							apply({ badgeMode: pair[0] });
						}
					},
					pair[1]
				);
			});

			return h(
				"div",
				null,
				h(
					"div",
					{ style: S.field },
					h("label", { style: S.fieldLabel }, "刷新间隔（秒，最小 15）"),
					h(
						"div",
						{ style: { display: "flex", gap: "6px" } },
						h("input", {
							style: Object.assign({}, S.input, { flex: "1" }),
							type: "number",
							min: 15,
							value: intervalDraft,
							onChange: function (e) {
								setIntervalDraft(e.target.value);
							},
							onKeyDown: function (e) {
								if (e.key === "Enter") apply({ intervalMs: Math.max(15, Number(intervalDraft) || 60) * 1000 });
							}
						}),
						h(
							"button",
							{
								style: S.btn,
								disabled: busy === "save",
								onClick: function () {
									apply({ intervalMs: Math.max(15, Number(intervalDraft) || 60) * 1000 });
								}
							},
							"应用"
						)
					)
				),
				h("div", { style: S.field }, h("label", { style: S.fieldLabel }, "角标位置"), h("div", { style: S.chipRow }, cornerChips)),
				h("div", { style: S.field }, h("label", { style: S.fieldLabel }, "角标显示"), h("div", { style: S.chipRow }, modeChips)),
				config.badgeMode === "active" && configured.length > 0
					? h(
							"div",
							{ style: S.field },
							h("label", { style: S.fieldLabel }, "当前站点"),
							h(
								"select",
								{
									style: S.input,
									value: config.activeSiteId || "",
									onChange: function (e) {
										apply({ activeSiteId: e.target.value });
									}
								},
								configured.map(function (site) {
									return h("option", { key: site.id, value: site.id }, site.name);
								})
							)
						)
					: null,
				h(
					"div",
					{ style: { display: "flex", gap: "14px", marginTop: "2px" } },
					h(
						"label",
						{ style: S.checkRow },
						h("input", {
							type: "checkbox",
							checked: config.enabled !== false,
							onChange: function (e) {
								apply({ enabled: e.target.checked });
							}
						}),
						"自动刷新"
					),
					h(
						"label",
						{ style: S.checkRow },
						h("input", {
							type: "checkbox",
							checked: Boolean(config.showSubscriptions),
							onChange: function (e) {
								apply({ showSubscriptions: e.target.checked });
							}
						}),
						"显示订阅"
					)
				)
			);
		}

		// ---------- 主组件 ----------
		function RelayBalanceBadge() {
			var dataHook = react.useState(null);
			var data = dataHook[0];
			var setData = dataHook[1];

			var openHook = react.useState(false);
			var open = openHook[0];
			var setOpen = openHook[1];

			var posHook = react.useState(loadPos);
			var pos = posHook[0];
			var setPos = posHook[1];

			var busyHook = react.useState("");
			var busy = busyHook[0];
			var setBusy = busyHook[1];

			var msgHook = react.useState(null);
			var msg = msgHook[0];
			var setMsg = msgHook[1];

			var editingHook = react.useState(null);
			var editing = editingHook[0];
			var setEditing = editingHook[1];

			var confirmHook = react.useState(null);
			var confirmRemove = confirmHook[0];
			var setConfirmRemove = confirmHook[1];

			var rotateHook = react.useState(0);
			var rotateIndex = rotateHook[0];
			var setRotateIndex = rotateHook[1];

			var rootRef = react.useRef(null);

			var load = react.useCallback(function (opts) {
				var force = Boolean(opts && opts.force);
				var id = opts && opts.id;
				return fetchState({ force: force, id: id })
					.then(function (state) {
						setData(state);
						return state;
					})
					.catch(function (err) {
						setData(function (prev) {
							return Object.assign({}, prev || {}, {
								status: "error",
								error: err instanceof Error ? err.message : String(err)
							});
						});
						return null;
					});
			}, []);

			react.useEffect(function () {
				var alive = true;
				var tick = function () {
					if (!alive) return;
					void load({});
				};
				tick();
				var timer = window.setInterval(tick, POLL_MS);
				return function () {
					alive = false;
					window.clearInterval(timer);
				};
			}, [load]);

			// 轮播模式：定时换一个站点
			react.useEffect(function () {
				var mode = data && data.config && data.config.badgeMode;
				if (mode !== "rotate") return;
				var timer = window.setInterval(function () {
					setRotateIndex(function (prev) {
						return prev + 1;
					});
				}, ROTATE_MS);
				return function () {
					window.clearInterval(timer);
				};
			}, [data && data.config && data.config.badgeMode]);

			// 点外部 / Esc 关闭
			react.useEffect(
				function () {
					if (!open) return;
					var onDown = function (event) {
						if (rootRef.current && !rootRef.current.contains(event.target)) setOpen(false);
					};
					var onKey = function (event) {
						if (event.key === "Escape") setOpen(false);
					};
					document.addEventListener("mousedown", onDown);
					document.addEventListener("keydown", onKey);
					return function () {
						document.removeEventListener("mousedown", onDown);
						document.removeEventListener("keydown", onKey);
					};
				},
				[open]
			);

			function applyPos(next) {
				setPos(next);
				savePos(next);
			}

			// 拖拽移动；位移小于阈值视为点击（展开面板）
			function onPointerDown(event) {
				if (event.button !== 0) return;
				if (event.target.closest && event.target.closest("[data-relay-balance-nodrag]")) return;
				var startX = event.clientX;
				var startY = event.clientY;
				var startDx = pos.dx;
				var startDy = pos.dy;
				var signs = anchorSigns(pos.corner);
				var moved = false;
				var latest = pos;

				function onMove(ev) {
					var ddx = ev.clientX - startX;
					var ddy = ev.clientY - startY;
					if (!moved && Math.abs(ddx) + Math.abs(ddy) < 4) return;
					moved = true;
					latest = { corner: pos.corner, dx: startDx + signs.sx * ddx, dy: startDy + signs.sy * ddy };
					setPos(latest);
				}
				function onUp() {
					document.removeEventListener("pointermove", onMove);
					document.removeEventListener("pointerup", onUp);
					if (moved) savePos(latest);
					else
						setOpen(function (prev) {
							return !prev;
						});
				}
				document.addEventListener("pointermove", onMove);
				document.addEventListener("pointerup", onUp);
			}

			function onRefresh(id) {
				setBusy(id || "all");
				setMsg(null);
				load({ force: true, id: id }).then(function () {
					setBusy("");
				});
			}

			function onRemove(id) {
				setBusy("remove");
				setMsg(null);
				postJson("/sites", { action: "remove", id: id })
					.then(function (body) {
						if (!body || body.ok !== true) throw new Error((body && body.message) || "删除失败");
						setData(body.state);
						setConfirmRemove(null);
						setEditing(null);
						setMsg({ tone: "ok", text: "已删除站点" });
					})
					.catch(function (err) {
						setMsg({ tone: "err", text: err instanceof Error ? err.message : String(err) });
					})
					.then(function () {
						setBusy("");
					});
			}

			var sites = siteList(data);
			var configured = configuredSites(data);
			var config = (data && data.config) || {};
			var mode = config.badgeMode || "total";

			// 角标文案
			var view = { status: (data && data.status) || "idle", label: "中转站", text: "读取中" };
			if (!data) {
				view = { status: "idle", label: "余额", text: "查询中" };
			} else if (sites.length === 0) {
				view = { status: "idle", label: "余额", text: "未添加站点" };
			} else if (configured.length === 0) {
				view = { status: "idle", label: "余额", text: "未配置" };
			} else if (mode === "total") {
				view = {
					status: data.status,
					label: "合计",
					text: totalOf(data) === null ? "--" : "$" + totalOf(data),
					suffix: configured.length + " 站"
				};
			} else {
				var focus = null;
				if (mode === "active") {
					focus = siteById(data, config.activeSiteId) || configured[0];
				} else {
					focus = configured[rotateIndex % configured.length];
				}
				if (focus) {
					view = {
						status: statusOfSite(focus),
						label: focus.name,
						text: moneyOf(focus)
					};
				}
			}

			var panelStyle = Object.assign({}, S.panel);
			Object.assign(
				panelStyle,
				pos.corner === "br" || pos.corner === "tr" ? { right: "0" } : { left: "0" },
				pos.corner === "br" || pos.corner === "bl" ? { bottom: "38px" } : { top: "38px" }
			);

			var children = [];

			var badgeKids = [
				h("span", {
					key: "dot",
					style: Object.assign({}, S.dot, { background: DOT_COLOR[view.status] || DOT_COLOR.idle })
				}),
				h("span", { key: "label", style: S.label }, view.label),
				h("span", { key: "amount", style: S.amount }, view.text)
			];
			if (view.suffix) {
				badgeKids.push(h("span", { key: "suffix", style: { color: "var(--dsw-alias-label-tertiary, #8a8a8a)" } }, view.suffix));
			}

			children.push(
				h(
					"div",
					{
						key: "badge",
						style: S.badge,
						onPointerDown: onPointerDown,
						title: (data && data.error) || "点击查看详情与配置（可拖动）",
						role: "button",
						tabIndex: 0
					},
					badgeKids
				)
			);

			if (open) {
				var counts = (data && data.counts) || { sites: 0, configured: 0, ok: 0, error: 0 };

				var rows = [];
				if (sites.length === 0 && editing !== "new") {
					rows.push(
						h("div", { key: "empty", style: S.hint }, "还没有站点。点下面的「+ 添加站点」，把中转站面板地址和 auth_token 填进来。")
					);
				}
				for (var i = 0; i < sites.length; i += 1) {
					var site = sites[i];
					rows.push(
						h(SiteRow, {
							key: site.id,
							site: site,
							busy: busy === site.id,
							confirmRemove: confirmRemove === site.id,
							onRefresh: onRefresh,
							onEdit: function (id) {
								setConfirmRemove(null);
								setEditing(id);
								setMsg(null);
							},
							onAskRemove: function (id) {
								setConfirmRemove(id);
								setEditing(null);
							},
							onCancelRemove: function () {
								setConfirmRemove(null);
							},
							onRemove: onRemove
						})
					);
					if (editing === site.id) {
						rows.push(
							h(SiteForm, {
								key: site.id + "-form",
								site: site,
								onCancel: function () {
									setEditing(null);
								},
								onSaved: function (state, text) {
									setData(state);
									setEditing(null);
									setMsg({ tone: "ok", text: text });
								}
							})
						);
					}
				}
				if (editing === "new") {
					rows.push(
						h(SiteForm, {
							key: "new-form",
							site: null,
							defaults: { baseUrl: "" },
							onCancel: function () {
								setEditing(null);
							},
							onSaved: function (state, text) {
								setData(state);
								setEditing(null);
								setMsg({ tone: "ok", text: text });
							}
						})
					);
				}

				var detailRows = [];
				if (mode === "total" && counts.sites > 0) {
					var summary = counts.ok + " / " + counts.configured + " 站正常";
					if (counts.error > 0) summary += " · " + counts.error + " 站异常";
					detailRows.push(
						h(
							"div",
							{ key: "sum", style: S.row },
							h("span", { style: S.rowKey }, "状态"),
							h("span", { style: S.rowVal }, summary)
						)
					);
				}
				if (data && data.updatedAt) {
					detailRows.push(
						h(
							"div",
							{ key: "upd", style: S.row },
							h("span", { style: S.rowKey }, "最近更新"),
							h("span", { style: S.rowVal }, fmtTime(data.updatedAt))
						)
					);
				}

				children.push(
					h(
						"div",
						{ key: "panel", style: panelStyle, "data-relay-balance-nodrag": "1" },
						h(
							"div",
							{ style: S.panelHead },
							h("span", { style: S.panelTitle }, "中转站余额"),
							h(
								"span",
								{ style: S.panelMeta },
								sites.length === 0 ? "未添加站点" : sites.length + " 个站点"
							)
						),
						mode === "total"
							? h(
									"div",
									{ style: S.bigAmount },
									totalOf(data) === null
										? "--"
										: [h("span", { key: "u", style: S.bigUnit }, "$"), totalOf(data)]
								)
							: null,
						detailRows.length > 0 ? h("div", null, detailRows) : null,
						data && data.error
							? h("div", { style: Object.assign({}, S.msg, { color: TONE_COLOR.err }) }, data.error)
							: null,
						h(
							"div",
							{ style: { display: "flex", gap: "6px", marginTop: "10px" } },
							h(
								"button",
								{ style: S.btn, onClick: function () { onRefresh(); }, disabled: busy === "all" },
								busy === "all" ? "刷新中…" : "刷新全部"
							),
							h(
								"button",
								{
									style: S.btn,
									onClick: function () {
										setConfirmRemove(null);
										setEditing("new");
										setMsg(null);
									},
									disabled: editing === "new"
								},
								"+ 添加站点"
							)
						),
						h("div", { style: S.divider }),
						h("div", { style: S.sectionTitle }, h("span", null, "站点")),
						h("div", null, rows),
						h("div", { style: S.divider }),
						h("div", { style: S.sectionTitle }, h("span", null, "设置")),
						h(Settings, {
							config: config,
							sites: sites,
							onSaved: function (state) {
								setData(state);
							},
							onMessage: setMsg
						}),
						msg
							? h("div", { style: Object.assign({}, S.msg, { color: TONE_COLOR[msg.tone] }) }, msg.text)
							: null
					)
				);
			}

			return h("div", { ref: rootRef, style: anchorStyle(pos) }, children);
		}

		function apply(ctx) {
			ctx.slots.inject("shell.overlay", function () {
				return ctx.slots.register(
					{
						name: "shell.overlay",
						id: "relay-balance",
						order: 95
					},
					RelayBalanceBadge
				);
			});
		}

		exports.apply = apply;
		exports.inject = ["slots"];
		return module.exports;
	}
});
