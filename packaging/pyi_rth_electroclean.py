"""PyInstaller runtime hook: runs before any ElectroClean code in the frozen applications.

The bundle contains only PySide6, so qtpy, pyqtgraph and matplotlib must use it
even if the user's environment asks for another Qt binding (for example a
``QT_API=pyqt5`` left over from another scientific Python installation).
"""

import os

os.environ["QT_API"] = "pyside6"
os.environ["PYQTGRAPH_QT_LIB"] = "PySide6"
