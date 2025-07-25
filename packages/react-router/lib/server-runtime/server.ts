import type { StaticHandler, StaticHandlerContext } from "../router/router";
import type { ErrorResponse, unstable_InitialContext } from "../router/utils";
import { unstable_RouterContextProvider } from "../router/utils";
import {
  isRouteErrorResponse,
  ErrorResponseImpl,
  stripBasename,
} from "../router/utils";
import {
  getStaticContextFromError,
  createStaticHandler,
  isRedirectResponse,
  isResponse,
} from "../router/router";
import type { AppLoadContext } from "./data";
import type { HandleErrorFunction, ServerBuild } from "./build";
import type { CriticalCss, EntryContext } from "../dom/ssr/entry";
import { createEntryRouteModules } from "./entry";
import { sanitizeErrors, serializeError, serializeErrors } from "./errors";
import { ServerMode, isServerMode } from "./mode";
import type { RouteMatch } from "./routeMatching";
import { matchServerRoutes } from "./routeMatching";
import type { ServerRoute } from "./routes";
import { createStaticHandlerDataRoutes, createRoutes } from "./routes";
import type { ServerHandoff } from "./serverHandoff";
import { createServerHandoffString } from "./serverHandoff";
import { getBuildTimeHeader, getDevServerHooks } from "./dev";
import {
  encodeViaTurboStream,
  getSingleFetchRedirect,
  singleFetchAction,
  singleFetchLoaders,
  SERVER_NO_BODY_STATUS_CODES,
} from "./single-fetch";
import { getDocumentHeaders } from "./headers";
import type { EntryRoute } from "../dom/ssr/routes";
import type {
  SingleFetchResult,
  SingleFetchResults,
} from "../dom/ssr/single-fetch";
import {
  SINGLE_FETCH_REDIRECT_STATUS,
  SingleFetchRedirectSymbol,
} from "../dom/ssr/single-fetch";
import type { MiddlewareEnabled } from "../types/future";
import { getManifestPath } from "../dom/ssr/fog-of-war";

export type RequestHandler = (
  request: Request,
  loadContext?: MiddlewareEnabled extends true
    ? unstable_InitialContext
    : AppLoadContext,
) => Promise<Response>;

export type CreateRequestHandlerFunction = (
  build: ServerBuild | (() => ServerBuild | Promise<ServerBuild>),
  mode?: string,
) => RequestHandler;

function derive(build: ServerBuild, mode?: string) {
  let routes = createRoutes(build.routes);
  let dataRoutes = createStaticHandlerDataRoutes(build.routes, build.future);
  let serverMode = isServerMode(mode) ? mode : ServerMode.Production;
  let staticHandler = createStaticHandler(dataRoutes, {
    basename: build.basename,
  });

  let errorHandler =
    build.entry.module.handleError ||
    ((error, { request }) => {
      if (serverMode !== ServerMode.Test && !request.signal.aborted) {
        console.error(
          // @ts-expect-error This is "private" from users but intended for internal use
          isRouteErrorResponse(error) && error.error ? error.error : error,
        );
      }
    });
  return {
    routes,
    dataRoutes,
    serverMode,
    staticHandler,
    errorHandler,
  };
}

export const createRequestHandler: CreateRequestHandlerFunction = (
  build,
  mode,
) => {
  let _build: ServerBuild;
  let routes: ServerRoute[];
  let serverMode: ServerMode;
  let staticHandler: StaticHandler;
  let errorHandler: HandleErrorFunction;

  return async function requestHandler(request, initialContext) {
    _build = typeof build === "function" ? await build() : build;

    if (typeof build === "function") {
      let derived = derive(_build, mode);
      routes = derived.routes;
      serverMode = derived.serverMode;
      staticHandler = derived.staticHandler;
      errorHandler = derived.errorHandler;
    } else if (!routes || !serverMode || !staticHandler || !errorHandler) {
      let derived = derive(_build, mode);
      routes = derived.routes;
      serverMode = derived.serverMode;
      staticHandler = derived.staticHandler;
      errorHandler = derived.errorHandler;
    }

    let params: RouteMatch<ServerRoute>["params"] = {};
    let loadContext: AppLoadContext | unstable_RouterContextProvider;

    let handleError = (error: unknown) => {
      if (mode === ServerMode.Development) {
        getDevServerHooks()?.processRequestError?.(error);
      }

      errorHandler(error, {
        context: loadContext,
        params,
        request,
      });
    };

    if (_build.future.unstable_middleware) {
      if (initialContext == null) {
        loadContext = new unstable_RouterContextProvider();
      } else {
        try {
          loadContext = new unstable_RouterContextProvider(
            initialContext as unknown as unstable_InitialContext,
          );
        } catch (e) {
          let error = new Error(
            "Unable to create initial `unstable_RouterContextProvider` instance. " +
              "Please confirm you are returning an instance of " +
              "`Map<unstable_routerContext, unknown>` from your `getLoadContext` function." +
              `\n\nError: ${e instanceof Error ? e.toString() : e}`,
          );
          handleError(error);
          return returnLastResortErrorResponse(error, serverMode);
        }
      }
    } else {
      loadContext = initialContext || {};
    }

    let url = new URL(request.url);

    let normalizedBasename = _build.basename || "/";
    let normalizedPath = url.pathname;
    if (stripBasename(normalizedPath, normalizedBasename) === "/_root.data") {
      normalizedPath = normalizedBasename;
    } else if (normalizedPath.endsWith(".data")) {
      normalizedPath = normalizedPath.replace(/\.data$/, "");
    }

    if (
      stripBasename(normalizedPath, normalizedBasename) !== "/" &&
      normalizedPath.endsWith("/")
    ) {
      normalizedPath = normalizedPath.slice(0, -1);
    }

    let isSpaMode =
      getBuildTimeHeader(request, "X-React-Router-SPA-Mode") === "yes";

    // When runtime SSR is disabled, make our dev server behave like the deployed
    // pre-rendered site would
    if (!_build.ssr) {
      // Decode the URL path before checking against the prerender config
      let decodedPath = decodeURI(normalizedPath);

      // When SSR is disabled this, file can only ever run during dev because we
      // delete the server build at the end of the build
      if (_build.prerender.length === 0) {
        // ssr:false and no prerender config indicates "SPA Mode"
        isSpaMode = true;
      } else if (
        !_build.prerender.includes(decodedPath) &&
        !_build.prerender.includes(decodedPath + "/")
      ) {
        if (url.pathname.endsWith(".data")) {
          // 404 on non-pre-rendered `.data` requests
          errorHandler(
            new ErrorResponseImpl(
              404,
              "Not Found",
              `Refusing to SSR the path \`${decodedPath}\` because \`ssr:false\` is set and the path is not included in the \`prerender\` config, so in production the path will be a 404.`,
            ),
            {
              context: loadContext,
              params,
              request,
            },
          );
          return new Response("Not Found", {
            status: 404,
            statusText: "Not Found",
          });
        } else {
          // Serve a SPA fallback for non-pre-rendered document requests
          isSpaMode = true;
        }
      }
    }

    // Manifest request for fog of war
    let manifestUrl = getManifestPath(
      _build.routeDiscovery.manifestPath,
      normalizedBasename,
    );
    if (url.pathname === manifestUrl) {
      try {
        let res = await handleManifestRequest(_build, routes, url);
        return res;
      } catch (e) {
        handleError(e);
        return new Response("Unknown Server Error", { status: 500 });
      }
    }

    let matches = matchServerRoutes(routes, normalizedPath, _build.basename);
    if (matches && matches.length > 0) {
      Object.assign(params, matches[0].params);
    }

    let response: Response;
    if (url.pathname.endsWith(".data")) {
      let handlerUrl = new URL(request.url);
      handlerUrl.pathname = normalizedPath;

      let singleFetchMatches = matchServerRoutes(
        routes,
        handlerUrl.pathname,
        _build.basename,
      );

      response = await handleSingleFetchRequest(
        serverMode,
        _build,
        staticHandler,
        request,
        handlerUrl,
        loadContext,
        handleError,
      );

      if (_build.entry.module.handleDataRequest) {
        response = await _build.entry.module.handleDataRequest(response, {
          context: loadContext,
          params: singleFetchMatches ? singleFetchMatches[0].params : {},
          request,
        });

        if (isRedirectResponse(response)) {
          let result: SingleFetchResult | SingleFetchResults =
            getSingleFetchRedirect(
              response.status,
              response.headers,
              _build.basename,
            );

          if (request.method === "GET") {
            result = {
              [SingleFetchRedirectSymbol]: result,
            };
          }
          let headers = new Headers(response.headers);
          headers.set("Content-Type", "text/x-script");

          return new Response(
            encodeViaTurboStream(
              result,
              request.signal,
              _build.entry.module.streamTimeout,
              serverMode,
            ),
            {
              status: SINGLE_FETCH_REDIRECT_STATUS,
              headers,
            },
          );
        }
      }
    } else if (
      !isSpaMode &&
      matches &&
      matches[matches.length - 1].route.module.default == null &&
      matches[matches.length - 1].route.module.ErrorBoundary == null
    ) {
      response = await handleResourceRequest(
        serverMode,
        _build,
        staticHandler,
        matches.slice(-1)[0].route.id,
        request,
        loadContext,
        handleError,
      );
    } else {
      let { pathname } = url;

      let criticalCss: CriticalCss | undefined = undefined;
      if (_build.unstable_getCriticalCss) {
        criticalCss = await _build.unstable_getCriticalCss({ pathname });
      } else if (
        mode === ServerMode.Development &&
        getDevServerHooks()?.getCriticalCss
      ) {
        criticalCss = await getDevServerHooks()?.getCriticalCss?.(pathname);
      }

      response = await handleDocumentRequest(
        serverMode,
        _build,
        staticHandler,
        request,
        loadContext,
        handleError,
        isSpaMode,
        criticalCss,
      );
    }

    if (request.method === "HEAD") {
      return new Response(null, {
        headers: response.headers,
        status: response.status,
        statusText: response.statusText,
      });
    }

    return response;
  };
};

async function handleManifestRequest(
  build: ServerBuild,
  routes: ServerRoute[],
  url: URL,
) {
  if (build.assets.version !== url.searchParams.get("version")) {
    return new Response(null, {
      status: 204,
      headers: {
        "X-Remix-Reload-Document": "true",
      },
    });
  }

  let patches: Record<string, EntryRoute> = {};

  if (url.searchParams.has("p")) {
    let paths = new Set<string>();

    // In addition to responding with the patches for the requested paths, we
    // need to include patches for each partial path so that we pick up any
    // pathless/index routes below ancestor segments.  So if we
    // get a request for `/parent/child`, we need to look for a match on `/parent`
    // so that if a `parent._index` route exists we return it so it's available
    // for client side matching if the user routes back up to `/parent`.
    // This is the same thing we do on initial load in <Scripts> via
    // `getPartialManifest()`
    url.searchParams.getAll("p").forEach((path) => {
      if (!path.startsWith("/")) {
        path = `/${path}`;
      }
      let segments = path.split("/").slice(1);
      segments.forEach((_, i) => {
        let partialPath = segments.slice(0, i + 1).join("/");
        paths.add(`/${partialPath}`);
      });
    });

    for (let path of paths) {
      let matches = matchServerRoutes(routes, path, build.basename);
      if (matches) {
        for (let match of matches) {
          let routeId = match.route.id;
          let route = build.assets.routes[routeId];
          if (route) {
            patches[routeId] = route;
          }
        }
      }
    }

    return Response.json(patches, {
      headers: {
        "Cache-Control": "public, max-age=31536000, immutable",
      },
    });
  }

  return new Response("Invalid Request", { status: 400 });
}

async function handleSingleFetchRequest(
  serverMode: ServerMode,
  build: ServerBuild,
  staticHandler: StaticHandler,
  request: Request,
  handlerUrl: URL,
  loadContext: AppLoadContext | unstable_RouterContextProvider,
  handleError: (err: unknown) => void,
): Promise<Response> {
  let response =
    request.method !== "GET"
      ? await singleFetchAction(
          build,
          serverMode,
          staticHandler,
          request,
          handlerUrl,
          loadContext,
          handleError,
        )
      : await singleFetchLoaders(
          build,
          serverMode,
          staticHandler,
          request,
          handlerUrl,
          loadContext,
          handleError,
        );

  return response;
}

async function handleDocumentRequest(
  serverMode: ServerMode,
  build: ServerBuild,
  staticHandler: StaticHandler,
  request: Request,
  loadContext: AppLoadContext | unstable_RouterContextProvider,
  handleError: (err: unknown) => void,
  isSpaMode: boolean,
  criticalCss?: CriticalCss,
) {
  try {
    let response = await staticHandler.query(request, {
      requestContext: loadContext,
      unstable_respond: build.future.unstable_middleware
        ? (ctx) => renderHtml(ctx, isSpaMode)
        : undefined,
    });
    // while middleware is still unstable, we don't run the middleware pipeline
    // if no routes have middleware, so we still might need to convert context
    // to a response here
    return isResponse(response) ? response : renderHtml(response, isSpaMode);
  } catch (error: unknown) {
    handleError(error);
    return new Response(null, { status: 500 });
  }

  async function renderHtml(context: StaticHandlerContext, isSpaMode: boolean) {
    if (isResponse(context)) {
      return context;
    }

    let headers = getDocumentHeaders(context, build);

    // Skip response body for unsupported status codes
    if (SERVER_NO_BODY_STATUS_CODES.has(context.statusCode)) {
      return new Response(null, { status: context.statusCode, headers });
    }

    // Sanitize errors outside of development environments
    if (context.errors) {
      Object.values(context.errors).forEach((err) => {
        // @ts-expect-error This is "private" from users but intended for internal use
        if (!isRouteErrorResponse(err) || err.error) {
          handleError(err);
        }
      });
      context.errors = sanitizeErrors(context.errors, serverMode);
    }

    // Server UI state to send to the client.
    // - When single fetch is enabled, this is streamed down via `serverHandoffStream`
    // - Otherwise it's stringified into `serverHandoffString`
    let state = {
      loaderData: context.loaderData,
      actionData: context.actionData,
      errors: serializeErrors(context.errors, serverMode),
    };
    let baseServerHandoff: ServerHandoff = {
      basename: build.basename,
      future: build.future,
      routeDiscovery: build.routeDiscovery,
      ssr: build.ssr,
      isSpaMode,
    };
    let entryContext: EntryContext = {
      manifest: build.assets,
      routeModules: createEntryRouteModules(build.routes),
      staticHandlerContext: context,
      criticalCss,
      serverHandoffString: createServerHandoffString({
        ...baseServerHandoff,
        criticalCss,
      }),
      serverHandoffStream: encodeViaTurboStream(
        state,
        request.signal,
        build.entry.module.streamTimeout,
        serverMode,
      ),
      renderMeta: {},
      future: build.future,
      ssr: build.ssr,
      routeDiscovery: build.routeDiscovery,
      isSpaMode,
      serializeError: (err) => serializeError(err, serverMode),
    };

    let handleDocumentRequestFunction = build.entry.module.default;
    try {
      return await handleDocumentRequestFunction(
        request,
        context.statusCode,
        headers,
        entryContext,
        loadContext as MiddlewareEnabled extends true
          ? unstable_RouterContextProvider
          : AppLoadContext,
      );
    } catch (error: unknown) {
      handleError(error);

      let errorForSecondRender = error;

      // If they threw a response, unwrap it into an ErrorResponse like we would
      // have for a loader/action
      if (isResponse(error)) {
        try {
          let data = await unwrapResponse(error);
          errorForSecondRender = new ErrorResponseImpl(
            error.status,
            error.statusText,
            data,
          );
        } catch (e) {
          // If we can't unwrap the response - just leave it as-is
        }
      }

      // Get a new StaticHandlerContext that contains the error at the right boundary
      context = getStaticContextFromError(
        staticHandler.dataRoutes,
        context,
        errorForSecondRender,
      );

      // Sanitize errors outside of development environments
      if (context.errors) {
        context.errors = sanitizeErrors(context.errors, serverMode);
      }

      // Get a new entryContext for the second render pass
      // Server UI state to send to the client.
      // - When single fetch is enabled, this is streamed down via `serverHandoffStream`
      // - Otherwise it's stringified into `serverHandoffString`
      let state = {
        loaderData: context.loaderData,
        actionData: context.actionData,
        errors: serializeErrors(context.errors, serverMode),
      };
      entryContext = {
        ...entryContext,
        staticHandlerContext: context,
        serverHandoffString: createServerHandoffString(baseServerHandoff),
        serverHandoffStream: encodeViaTurboStream(
          state,
          request.signal,
          build.entry.module.streamTimeout,
          serverMode,
        ),
        renderMeta: {},
      };

      try {
        return await handleDocumentRequestFunction(
          request,
          context.statusCode,
          headers,
          entryContext,
          loadContext as MiddlewareEnabled extends true
            ? unstable_RouterContextProvider
            : AppLoadContext,
        );
      } catch (error: any) {
        handleError(error);
        return returnLastResortErrorResponse(error, serverMode);
      }
    }
  }
}

async function handleResourceRequest(
  serverMode: ServerMode,
  build: ServerBuild,
  staticHandler: StaticHandler,
  routeId: string,
  request: Request,
  loadContext: AppLoadContext | unstable_RouterContextProvider,
  handleError: (err: unknown) => void,
) {
  try {
    // Note we keep the routeId here to align with the Remix handling of
    // resource routes which doesn't take ?index into account and just takes
    // the leaf match
    let response = await staticHandler.queryRoute(request, {
      routeId,
      requestContext: loadContext,
      unstable_respond: build.future.unstable_middleware
        ? (ctx) => ctx
        : undefined,
    });

    if (isResponse(response)) {
      return response;
    }

    if (typeof response === "string") {
      return new Response(response);
    }

    return Response.json(response);
  } catch (error: unknown) {
    if (isResponse(error)) {
      // Note: Not functionally required but ensures that our response headers
      // match identically to what Remix returns
      error.headers.set("X-Remix-Catch", "yes");
      return error;
    }

    if (isRouteErrorResponse(error)) {
      if (error) {
        handleError(error);
      }
      return errorResponseToJson(error, serverMode);
    }

    if (
      error instanceof Error &&
      error.message === "Expected a response from queryRoute"
    ) {
      let newError = new Error(
        "Expected a Response to be returned from resource route handler",
      );
      handleError(newError);
      return returnLastResortErrorResponse(newError, serverMode);
    }

    handleError(error);
    return returnLastResortErrorResponse(error, serverMode);
  }
}

function errorResponseToJson(
  errorResponse: ErrorResponse,
  serverMode: ServerMode,
): Response {
  return Response.json(
    serializeError(
      // @ts-expect-error This is "private" from users but intended for internal use
      errorResponse.error || new Error("Unexpected Server Error"),
      serverMode,
    ),
    {
      status: errorResponse.status,
      statusText: errorResponse.statusText,
      headers: {
        "X-Remix-Error": "yes",
      },
    },
  );
}

function returnLastResortErrorResponse(error: any, serverMode?: ServerMode) {
  let message = "Unexpected Server Error";

  if (serverMode !== ServerMode.Production) {
    message += `\n\n${String(error)}`;
  }

  // Good grief folks, get your act together 😂!
  return new Response(message, {
    status: 500,
    headers: {
      "Content-Type": "text/plain",
    },
  });
}

function unwrapResponse(response: Response) {
  let contentType = response.headers.get("Content-Type");
  // Check between word boundaries instead of startsWith() due to the last
  // paragraph of https://httpwg.org/specs/rfc9110.html#field.content-type
  return contentType && /\bapplication\/json\b/.test(contentType)
    ? response.body == null
      ? null
      : response.json()
    : response.text();
}
