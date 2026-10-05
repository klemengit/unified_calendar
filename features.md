# Feature requests

- Tasks in the web app. The widget's Tasks tab is the only task UI so far; a web
  view could reuse `parseQuickAdd` and `resolveListToken` from `src/tasks.js`,
  including the `+list` quick-add token.
- Create, rename and delete task lists from the widget. Lists are only read
  today; a new list has to be made in the CalDAV provider's own UI, after which
  the widget's refresh button picks it up.
