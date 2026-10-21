export const ROLE_HEADER_COLLAPSED_ATTRIBUTE = 'data-reachany-role-header-collapsed';
export const ROLE_HEADER_COLLAPSE_STORAGE_KEY = 'reachany:role-header-collapsed:v1';

const persistenceScript = `try {
  var collapsed = window.sessionStorage.getItem(${JSON.stringify(ROLE_HEADER_COLLAPSE_STORAGE_KEY)});
  if (collapsed === 'true') {
    document.documentElement.setAttribute(${JSON.stringify(ROLE_HEADER_COLLAPSED_ATTRIBUTE)}, 'true');
  } else {
    document.documentElement.removeAttribute(${JSON.stringify(ROLE_HEADER_COLLAPSED_ATTRIBUTE)});
    if (collapsed !== null) window.sessionStorage.removeItem(${JSON.stringify(ROLE_HEADER_COLLAPSE_STORAGE_KEY)});
  }
} catch (_error) {
  document.documentElement.removeAttribute(${JSON.stringify(ROLE_HEADER_COLLAPSED_ATTRIBUTE)});
}`;

export function RoleHeaderPersistenceScript() {
  return (
    <script
      data-reachany-role-header-persistence="true"
      dangerouslySetInnerHTML={{ __html: persistenceScript }}
    />
  );
}
